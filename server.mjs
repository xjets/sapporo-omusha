// Omusha 1808 web server.
//
// - Serves the app (src/), character sheets (characters/) and the sample capture (sample/).
// - Serves /assets/... (museum splat, figure models) from a private S3-compatible bucket when
//   BUCKET is set (Railway Buckets), otherwise from the local assets/ folder. These files are
//   reproductions of museum material and are never committed to the repository.
// - APP_PASSWORD turns on one shared password (HTTP Basic auth, any user name) for everything
//   except /healthz.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { talkPrompt } from './talk-prompt.mjs';
import { translateJa } from './translate.mjs';
import { createGather } from './gather.mjs';

try { process.loadEnvFile(); } catch { /* no .env */ }

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT) || 8081;
const PUBLIC_DIRS = ['src', 'characters', 'sample', 'gather'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
  '.glb': 'model/gltf-binary', '.sog': 'application/octet-stream', '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream', '.splat': 'application/octet-stream', '.ksplat': 'application/octet-stream',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ---- Password
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const digest = (s) => createHash('sha256').update(s).digest();
const expected = APP_PASSWORD ? digest(APP_PASSWORD) : null;
function authorised(req) {
  if (!expected) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return timingSafeEqual(digest(decoded.slice(decoded.indexOf(':') + 1)), expected);
}

// ---- Bucket (optional)
let s3 = null;
if (process.env.BUCKET) {
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: process.env.ENDPOINT,
    region: process.env.REGION || 'auto',
    forcePathStyle: process.env.BUCKET_PATH_STYLE === 'true',
    credentials: { accessKeyId: process.env.ACCESS_KEY_ID, secretAccessKey: process.env.SECRET_ACCESS_KEY },
  });
  s3 = { client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand, bucket: process.env.BUCKET };
}

// Uploads and deletes of assets need the site password AND this token (x-upload-token header).
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const tokenOk = (req) => UPLOAD_TOKEN && req.headers['x-upload-token'] &&
  timingSafeEqual(digest(String(req.headers['x-upload-token'])), digest(UPLOAD_TOKEN));
const ASSET_KEY = /^(figures\/[a-z0-9-]+\/model-web\.glb|[a-z0-9-]+\.(sog|spz))$/;

async function writeAsset(req, res, key) {
  if (!s3) { res.writeHead(501, { 'content-type': 'text/plain' }); return res.end('No bucket configured'); }
  if (!tokenOk(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Upload token required'); }
  if (req.method === 'GET') { // listing: GET /assets/?list
    const out = await s3.client.send(new s3.ListObjectsV2Command({ Bucket: s3.bucket }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify((out.Contents || []).map((o) => ({ key: o.Key, size: o.Size }))));
  }
  if (req.method === 'DELETE' && key === '*') { // take every museum asset down; gathered records and their files are left alone
    let token, deleted = 0, kept = 0;
    do {
      const out = await s3.client.send(new s3.ListObjectsV2Command({ Bucket: s3.bucket, ContinuationToken: token }));
      for (const o of out.Contents || []) {
        if (!ASSET_KEY.test(o.Key)) { kept++; continue; }
        await s3.client.send(new s3.DeleteObjectCommand({ Bucket: s3.bucket, Key: o.Key })); deleted++;
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`Deleted ${deleted} museum assets; left ${kept} other objects`);
  }
  if (!ASSET_KEY.test(key)) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('Unexpected asset path'); }
  if (req.method === 'DELETE') {
    await s3.client.send(new s3.DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
    res.writeHead(204); return res.end();
  }
  const length = Number(req.headers['content-length']);
  if (!length) { res.writeHead(411); return res.end(); }
  await s3.client.send(new s3.PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: req, ContentLength: length, ContentType: mimeOf(key) }));
  res.writeHead(201, { 'content-type': 'text/plain' }); res.end(`Stored ${key} (${length} bytes)`);
}

// ---- Envelope observations
// The seed record is in the repo (envelopes/observations.jsonl). Additions made through the app
// are appended to a separate store (bucket, or data/ locally) and never rewrite earlier lines.
const OBS_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'envelopes', 'schema', 'observation.schema.json'), 'utf8'));
const ENUMS = {
  kind: OBS_SCHEMA.properties.kind.enum,
  stratum: OBS_SCHEMA.properties.stratum.enum,
  evidence: OBS_SCHEMA.properties.evidence.enum,
  perspective: OBS_SCHEMA.properties.perspective.enum,
  sourceType: OBS_SCHEMA.properties.source.properties.type.enum,
  role: OBS_SCHEMA.properties.standing.properties.role.enum,
  cause: OBS_SCHEMA.properties.absence.properties.cause.enum,
  audience: OBS_SCHEMA.properties.protocol.properties.audience.enum,
};
const ADDITIONS_KEY = 'observations/additions.jsonl';
const LOCAL_ADDITIONS = path.join(ROOT, 'data', 'additions.jsonl');
const parseLines = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

async function readAdditions() {
  if (!s3) return fs.existsSync(LOCAL_ADDITIONS) ? fs.readFileSync(LOCAL_ADDITIONS, 'utf8') : '';
  try {
    const out = await s3.client.send(new s3.GetObjectCommand({ Bucket: s3.bucket, Key: ADDITIONS_KEY }));
    return await out.Body.transformToString();
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return '';
    throw err;
  }
}
async function writeAdditions(text) {
  if (!s3) { fs.mkdirSync(path.dirname(LOCAL_ADDITIONS), { recursive: true }); return fs.writeFileSync(LOCAL_ADDITIONS, text); }
  await s3.client.send(new s3.PutObjectCommand({ Bucket: s3.bucket, Key: ADDITIONS_KEY, Body: text, ContentType: 'application/x-ndjson' }));
}
async function allObservations() {
  const seed = parseLines(fs.readFileSync(path.join(ROOT, 'envelopes', 'observations.jsonl'), 'utf8'));
  return seed.concat(parseLines(await readAdditions()));
}

// Protocol gate: everyone signed in to this site is "team". Family- and community-only
// observations are withheld until per-person access exists.
const VISIBLE_TO_TEAM = new Set(['public', 'team']);
const visible = (o) => VISIBLE_TO_TEAM.has(o.protocol?.audience || 'public');

function validateNew(body, existing) {
  const s = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const errors = [];
  const o = {
    envelopes: Array.isArray(body.envelopes) ? body.envelopes.map((e) => s(e, 80)).filter(Boolean) : [],
    about: Array.isArray(body.about) ? body.about.map((a) => s(a, 80)).filter(Boolean) : [],
    kind: s(body.kind, 40), stratum: s(body.stratum, 40), claim: s(body.claim, 2000),
    source: { type: s(body.source?.type, 40), ref: s(body.source?.ref, 500) },
    evidence: s(body.evidence, 40),
    standing: { role: s(body.standing?.role, 40), grantedBy: s(body.standing?.grantedBy, 200) },
    perspective: s(body.perspective, 40) || 'project',
    protocol: { audience: s(body.protocol?.audience, 20) || 'public' },
    author: s(body.author, 120), note: s(body.note, 1000),
  };
  if (s(body.source?.quote, 300)) o.source.quote = s(body.source.quote, 300);
  if (!o.envelopes.length) errors.push('envelopes');
  if (!o.claim) errors.push('claim');
  if (!o.author) errors.push('author (your name)');
  if (!o.source.ref) errors.push('source');
  for (const [field, list] of [['kind', ENUMS.kind], ['stratum', ENUMS.stratum], ['evidence', ENUMS.evidence], ['perspective', ENUMS.perspective]]) {
    if (!list.includes(o[field])) errors.push(field);
  }
  if (!ENUMS.sourceType.includes(o.source.type)) errors.push('source type');
  if (!ENUMS.role.includes(o.standing.role)) errors.push('standing');
  if (!ENUMS.audience.includes(o.protocol.audience)) errors.push('audience');
  if (o.kind === 'absence') {
    o.absence = { cause: s(body.absence?.cause, 40), note: s(body.absence?.note, 500) };
    if (!ENUMS.cause.includes(o.absence.cause)) errors.push('absence cause');
  }
  if (body.supersedes) {
    o.supersedes = s(body.supersedes, 80);
    if (!existing.some((e) => e.id === o.supersedes)) errors.push('supersedes (unknown observation)');
  }
  if (!o.note) delete o.note;
  if (!o.about.length) delete o.about;
  if (!o.standing.grantedBy) o.standing.grantedBy = '';
  return { errors, o };
}

// ---- Talk: a figure answers only from the observations that pass the protocol gate.
// Behaviour follows training/SPEC.md: period voice, nothing after 1808, each claim labelled
// documented or inferred with its perspective, gaps answered as gaps, no invented Ainu belief.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Thinking makes answers several times slower; minimal keeps Talk under about 2 s. GEMINI_THINKING=low|medium|high to trade speed for care.
const GEMINI_THINKING = process.env.GEMINI_THINKING || 'minimal';
const CHAR_DIR = path.join(ROOT, 'characters', '1808');
const TALK_PER_MINUTE = 30;
let talkWindow = { start: 0, count: 0 };

function currentVisible(all) {
  const superseded = new Set(all.filter((o) => o.supersedes).map((o) => o.supersedes));
  return all.filter((o) => visible(o) && !superseded.has(o.id));
}

const TALK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    cites: { type: 'ARRAY', items: { type: 'STRING' } },
    grounding: { type: 'STRING', enum: ['documented', 'inferred', 'unknown', 'declined'] },
  },
  required: ['answer', 'cites', 'grounding'],
};

async function talk(body) {
  if (!GEMINI_API_KEY) return { status: 503, data: { error: 'Talk is not set up on this server yet (GEMINI_API_KEY is missing).' } };
  const now = Date.now();
  if (now - talkWindow.start > 60000) talkWindow = { start: now, count: 0 };
  if (++talkWindow.count > TALK_PER_MINUTE) return { status: 429, data: { error: 'Too many questions this minute. Try again shortly.' } };

  const id = typeof body.figure === 'string' && /^[a-z0-9-]+$/.test(body.figure) ? body.figure : '';
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  const lang = body.lang === 'ja' || body.lang === 'en' ? body.lang : undefined;
  if (!id || !question) return { status: 400, data: { error: 'Send a figure and a question.' } };
  const index = JSON.parse(fs.readFileSync(path.join(CHAR_DIR, 'index.json'), 'utf8')).characters;
  if (!index.includes(id)) return { status: 404, data: { error: 'Unknown figure.' } };
  const characters = Object.fromEntries(index.map((c) => [c, JSON.parse(fs.readFileSync(path.join(CHAR_DIR, `${c}.json`), 'utf8'))]));
  const observations = currentVisible(await allObservations());
  const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
    .filter((t) => (t.role === 'user' || t.role === 'model') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, parts: [{ text: t.text.slice(0, 1500) }] }));

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: talkPrompt(characters[id], observations, characters, lang) }] },
      contents: [...history, { role: 'user', parts: [{ text: question }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: TALK_SCHEMA, thinkingConfig: { thinkingLevel: GEMINI_THINKING } },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    console.error('gemini', res.status, (await res.text()).slice(0, 300));
    return { status: 502, data: { error: 'The figure could not answer just now.' } };
  }
  const out = await res.json();
  const text = out.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { status: 502, data: { error: 'The figure could not answer just now.' } }; }
  const known = new Set(observations.map((o) => o.id));
  return {
    status: 200,
    data: {
      answer: String(parsed.answer || '').slice(0, 2000),
      cites: [...new Set((parsed.cites || []).filter((c) => known.has(c)))],
      grounding: ['documented', 'inferred', 'unknown', 'declined'].includes(parsed.grounding) ? parsed.grounding : 'inferred',
      model: GEMINI_MODEL,
    },
  };
}

// ---- Voice (ElevenLabs): spoken answers and speech-to-text for questions.
// Elders and the Ainu woman speak through the interpreter, so the interpreter's voice reads their answers.
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
// Japanese: eleven_v3 pronounced a test passage almost perfectly (checked by a Scribe round trip);
// multilingual_v2, flash and turbo garbled about half of it. v3 takes about 4 s instead of 1 to 2.
const TTS_MODEL_JA = process.env.ELEVENLABS_TTS_MODEL_JA || 'eleven_v3';
const TTS_MODELS = ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_v3'];
// language_code is honoured by these models and ignored or refused by the others.
const LANG_CODE_MODELS = new Set(['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_v3']);
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
// Premade ElevenLabs voices; override with ELEVENLABS_VOICES='{"interpreter":"<voice id>",...}'.
const VOICES = {
  interpreter: 'JBFqnCBsd6RMkjVDRZzb', // George: warm, measured
  officer: 'onwK4e9ZLuTAKqWW03F9', // Daniel: formal, authoritative
  soldier: 'nPczCjzI2devNBz1zQrb', // Brian: plain, younger
  narrator: 'JBFqnCBsd6RMkjVDRZzb',
  ...(() => { try { return JSON.parse(process.env.ELEVENLABS_VOICES || '{}'); } catch { return {}; } })(),
};
function voiceFor(id) {
  if (id === 'aizu-officer') return VOICES.officer;
  if (id === 'aizu-soldier') return VOICES.soldier;
  if (id === 'interpreter') return VOICES.interpreter;
  const c = fs.existsSync(path.join(CHAR_DIR, `${id}.json`)) ? JSON.parse(fs.readFileSync(path.join(CHAR_DIR, `${id}.json`), 'utf8')) : null;
  return c?.voice?.routes_through === 'interpreter' ? VOICES.interpreter : VOICES.narrator;
}
const ttsCache = new Map(); // text+voice -> mp3 Buffer, so replays cost no credits
const forSpeech = (t) => t.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*【[^】]*】/g, '').replace(/^\(Through the interpreter\)\s*/i, 'Through the interpreter. ').replace(/^（通辞を介して）\s*/, 'つうじを介して。').replace(/通辞/g, 'つうじ').trim();
let voiceWindow = { start: 0, count: 0 };
const voiceLimited = () => {
  const now = Date.now();
  if (now - voiceWindow.start > 60000) voiceWindow = { start: now, count: 0 };
  return ++voiceWindow.count > 40;
};

async function speak(req, res) {
  if (!ELEVEN_KEY) return sendJson(res, 503, { error: 'Voice is not set up on this server (ELEVENLABS_API_KEY is missing).' });
  let body;
  try { body = await readJson(req, 10000); } catch { return sendJson(res, 400, { error: 'Send JSON' }); }
  const text = forSpeech(typeof body.text === 'string' ? body.text : '').slice(0, 1200);
  if (!text) return sendJson(res, 400, { error: 'Nothing to say.' });
  const voice = voiceFor(typeof body.figure === 'string' && /^[a-z0-9-]+$/.test(body.figure) ? body.figure : '');
  const lang = body.lang === 'ja' || body.lang === 'en' ? body.lang : '';
  const model = TTS_MODELS.includes(body.model) ? body.model : (lang === 'ja' ? TTS_MODEL_JA : TTS_MODEL);
  const key = createHash('sha256').update(`${voice}|${model}|${lang}|${text}`).digest('hex');
  let audio = ttsCache.get(key);
  if (!audio) {
    if (voiceLimited()) return sendJson(res, 429, { error: 'Too many voice requests this minute.' });
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model, ...(lang && LANG_CODE_MODELS.has(model) && { language_code: lang }), voice_settings: { stability: 0.55, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      console.error('elevenlabs tts', r.status, (await r.text()).slice(0, 300));
      return sendJson(res, 502, { error: 'The voice could not be made just now.' });
    }
    audio = Buffer.from(await r.arrayBuffer());
    if (ttsCache.size > 300) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(key, audio);
  }
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'private, max-age=86400' });
  res.end(audio);
}

// Tidies a raw transcript so it reads well: fillers and stumbles out, punctuation in, nothing else changed.
const TIDY_RULES = [
  'You clean up a raw speech-to-text transcript so it is presentable to read. The speaker is recording their own memories; their words are the record, so change as little as possible.',
  'Remove: filler sounds and words (uh, um, er, ah, hmm, like, you know, I mean, well, so, when they carry no meaning; Japanese: えー, えーと, えっと, あの, あのー, その, まあ, なんか, こう, when they are only fillers), stutters and immediately repeated words, false starts that the speaker then restarts, and transcription tags such as (laughs) or [noise].',
  'Fix: punctuation, capital letters, sentence breaks, and obvious spacing. Start a new paragraph only where the subject clearly changes.',
  'Never: paraphrase, summarise, reorder, translate, add words, correct facts or grammar beyond the above, or change dialect, names, dates, numbers, or expressions of doubt ("I think", "maybe", "around", たぶん, ～かな). If the speaker corrects themself ("in 1955, no, 1956"), keep the correction as said.',
  'Return only the cleaned text, in the same language, with no comment.',
].join('\n');
async function tidy(text, lang) {
  if (!GEMINI_API_KEY || text.length < 12) return text;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TIDY_RULES }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 6000, thinkingConfig: { thinkingLevel: 'minimal' } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error('tidy', res.status, (await res.text()).slice(0, 200)); return text; }
    const out = ((await res.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    // A tidy-up only trims. Anything much shorter or longer has been rewritten, so the raw words are kept.
    return out && out.length >= text.length * 0.45 && out.length <= text.length * 1.15 ? out : text;
  } catch (err) { console.error('tidy', err.message); return text; }
}

async function listen(req, res) {
  if (!ELEVEN_KEY) return sendJson(res, 503, { error: 'Voice input is not set up on this server (ELEVENLABS_API_KEY is missing).' });
  if (voiceLimited()) return sendJson(res, 429, { error: 'Too many voice requests this minute.' });
  const type = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
  if (!/^audio\/|^video\/webm/.test(type)) return sendJson(res, 415, { error: 'Send audio.' });
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 2e7) return sendJson(res, 413, { error: 'Recording too long.' }); chunks.push(c); }
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  const lang = new URL(req.url, 'http://x').searchParams.get('lang');
  if (lang === 'ja' || lang === 'en') form.append('language_code', lang);
  form.append('file', new Blob([Buffer.concat(chunks)], { type }), `question.${type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'}`);
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: form, signal: AbortSignal.timeout(45000) });
  if (!r.ok) {
    console.error('elevenlabs stt', r.status, (await r.text()).slice(0, 300));
    return sendJson(res, 502, { error: 'Could not hear that. Try again or type the question.' });
  }
  const out = await r.json();
  const raw = String(out.text || '').trim();
  const wantTidy = new URL(req.url, 'http://x').searchParams.get('tidy') === '1';
  return sendJson(res, 200, { text: wantTidy ? await tidy(raw, lang) : raw, raw, language: out.language_code || '' });
}

async function voiceList(res) {
  if (!ELEVEN_KEY) return sendJson(res, 503, { error: 'ELEVENLABS_API_KEY is missing.' });
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': ELEVEN_KEY } });
  if (!r.ok) return sendJson(res, 502, { error: `ElevenLabs ${r.status}` });
  const out = await r.json();
  return sendJson(res, 200, { model: TTS_MODEL, using: VOICES, voices: (out.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels })) });
}

// ---- Japanese view of the record. The seed has a machine translation in envelopes/ja.json
// (to be reviewed); observations added through the app are translated on first view and cached.
const JA_SEED = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'envelopes', 'ja.json'), 'utf8')).observations; } catch { return {}; } })();
const jaCache = new Map();
async function withJapanese(list) {
  const missing = list.filter((o) => !JA_SEED[o.id] && !jaCache.has(o.id)).slice(0, 40);
  if (missing.length) {
    const items = {};
    for (const o of missing) {
      items[`${o.id}|claim`] = o.claim;
      if (o.note) items[`${o.id}|note`] = o.note;
      if (o.absence?.note) items[`${o.id}|absenceNote`] = o.absence.note;
      if (o.source?.ref) items[`${o.id}|sourceRef`] = o.source.ref;
    }
    try {
      const ja = await translateJa(items);
      for (const o of missing) {
        const pick = (f) => ja[`${o.id}|${f}`];
        if (pick('claim')) jaCache.set(o.id, { claim: pick('claim'), note: pick('note'), absenceNote: pick('absenceNote'), sourceRef: pick('sourceRef') });
      }
    } catch (err) { console.error('translate', err.message); }
  }
  return list.map((o) => {
    const ja = JA_SEED[o.id] || jaCache.get(o.id);
    return ja ? { ...o, ja: { ...ja, machine: true } } : o;
  });
}

let appendQueue = Promise.resolve();
async function readJson(req, limit = 20000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const sendJson = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

// Gather: the interviewer's input page (/gather/), with its own record apart from the Omusha demo.
const gather = createGather({ ROOT, s3, sendJson, readJson, mimeOf, isAdmin: (req) => tokenOk(req) });

async function handleApi(req, res, pathname) {
  if (pathname.startsWith('/api/gather/')) return gather.handle(req, res, pathname);
  if (pathname === '/api/envelopes' && req.method === 'GET') {
    const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'envelopes', 'index.json'), 'utf8'));
    let forms = [];
    try { forms = JSON.parse(fs.readFileSync(path.join(ROOT, 'envelopes', 'forms.json'), 'utf8')).forms; } catch { /* no forms yet */ }
    return sendJson(res, 200, { ...index, forms });
  }
  if (pathname === '/api/observations' && req.method === 'GET') {
    const list = (await allObservations()).filter(visible);
    if (new URL(req.url, 'http://x').searchParams.get('lang') === 'ja') return sendJson(res, 200, await withJapanese(list));
    return sendJson(res, 200, list);
  }
  if (pathname === '/api/observations' && req.method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (err) { return sendJson(res, err.status || 400, { error: 'Send JSON' }); }
    // Serialise appends so two curators can't overwrite each other's line.
    const result = appendQueue.then(async () => {
      const existing = await allObservations();
      const { errors, o } = validateNew(body, existing);
      if (errors.length) return { status: 400, data: { error: `Missing or invalid: ${errors.join(', ')}` } };
      const full = { id: `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ...o, status: 'unverified', createdAt: new Date().toISOString() };
      await writeAdditions((await readAdditions()) + JSON.stringify(full) + '\n');
      return { status: 201, data: full };
    });
    appendQueue = result.catch(() => {});
    const { status, data } = await result;
    return sendJson(res, status, data);
  }
  if (pathname === '/api/speak' && req.method === 'POST') return speak(req, res);
  if (pathname === '/api/listen' && req.method === 'POST') return listen(req, res);
  if (pathname === '/api/tidy' && req.method === 'POST') { // the same tidy-up for text that was not recorded here
    let body;
    try { body = await readJson(req, 40000); } catch (err) { return sendJson(res, err.status || 400, { error: 'Send JSON' }); }
    const raw = String(body.text || '').trim().slice(0, 12000);
    return sendJson(res, 200, { text: await tidy(raw, body.lang), raw });
  }
  if (pathname === '/api/voices' && req.method === 'GET') return voiceList(res);
  if (pathname === '/api/voice-status' && req.method === 'GET') return sendJson(res, 200, { voice: Boolean(ELEVEN_KEY), talk: Boolean(GEMINI_API_KEY) });
  if (pathname === '/api/talk' && req.method === 'POST') {
    let body;
    try { body = await readJson(req, 20000); } catch (err) { return sendJson(res, err.status || 400, { error: 'Send JSON' }); }
    const { status, data } = await talk(body);
    return sendJson(res, status, data);
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// Keeps a request path inside a base folder; returns null for anything that escapes it.
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

function sendFile(res, file, cache, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    // Byte ranges, which Safari needs before it will play a video
    const m = /^bytes=(\d*)-(\d*)$/.exec(req?.headers.range || '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'content-type': mimeOf(file), 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'cache-control': cache });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': st.size, 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

async function sendAsset(res, key) {
  const cache = 'private, max-age=3600';
  if (!s3) {
    const file = safeJoin(path.join(ROOT, 'assets'), key);
    return file ? sendFile(res, file, cache) : (res.writeHead(404), res.end());
  }
  // The bucket also holds gathered records, so only keys shaped like a museum asset are ever served from here.
  if (!ASSET_KEY.test(key)) { res.writeHead(404); return res.end(); }
  try {
    const out = await s3.client.send(new s3.GetObjectCommand({ Bucket: s3.bucket, Key: key }));
    res.writeHead(200, {
      'content-type': mimeOf(key),
      ...(out.ContentLength != null && { 'content-length': out.ContentLength }),
      'cache-control': cache,
    });
    Readable.fromWeb(out.Body.transformToWebStream()).pipe(res);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey' ? 404 : 502;
    if (status !== 404) console.error('bucket error', key, err?.name, err?.message);
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(status === 404 ? 'Not found' : 'Asset storage error');
  }
}

// One bad request must never end the process: anything a handler throws becomes a 500 for that request only.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('request failed', req.method, String(req.url).slice(0, 120), err?.message);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch { /* connection already gone */ }
  });
});
async function handle(req, res) {
  let url, pathname;
  try { url = new URL(req.url, 'http://x'); pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('Bad request'); }
  if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }

  if (!authorised(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Omusha 1808", charset="UTF-8"', 'content-type': 'text/plain' });
    return res.end('Password required.');
  }
  // Keep search engines and AI crawlers out of the whole site.
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, noai, noimageai');
  if (pathname.startsWith('/api/')) {
    try { return await handleApi(req, res, pathname); }
    catch (err) { console.error('api error', err?.name, err?.message); return sendJson(res, 500, { error: 'Something went wrong' }); }
  }
  if (pathname.startsWith('/assets/') && (req.method === 'PUT' || req.method === 'DELETE' || url.searchParams.has('list'))) {
    try { return await writeAsset(req, res, pathname.slice('/assets/'.length)); }
    catch (err) { console.error('upload error', err?.name, err?.message); res.writeHead(502); return res.end('Asset storage error'); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  if (pathname === '/' || pathname === '') { // the entry page; old links that open a figure or a capture still go to the diorama
    if (url.searchParams.has('figure') || url.searchParams.has('src') || url.searchParams.has('edit')) { res.writeHead(302, { location: '/src/' + url.search }); return res.end(); }
    return sendFile(res, path.join(ROOT, 'index.html'), 'no-cache');
  }
  if (pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
  if (pathname.startsWith('/assets/')) return sendAsset(res, pathname.slice('/assets/'.length));

  const top = pathname.split('/')[1];
  if (!PUBLIC_DIRS.includes(top)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  let file = safeJoin(ROOT, pathname.slice(1));
  if (!file) { res.writeHead(400); return res.end(); }
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  sendFile(res, file, /\.(mp4|woff2)$/.test(file) ? 'public, max-age=3600' : 'no-cache', req);
}

server.listen(PORT, () => {
  console.log(`Omusha running at http://localhost:${PORT}/`);
  console.log(`  password: ${APP_PASSWORD ? 'on' : 'off (set APP_PASSWORD before sharing)'}`);
  console.log(`  assets:   ${s3 ? `bucket ${s3.bucket}` : 'local assets/ folder'}`);
});
