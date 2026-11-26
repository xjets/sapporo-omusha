// Gather: the input side of the Envelope. An interviewer records what an older resident knows about
// a place or thing; the transcript is split into draft observations across the layers, the next
// question is chosen from what the record still lacks, and nothing is saved until the interviewer
// has reviewed it. Stored apart from the Omusha demo record, append-only (bucket: gather/…, or
// data/gather/ locally). Audio is transcribed and not kept.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GATHER_ENUMS = {
  scale: ['keepsake', 'room', 'building', 'neighborhood', 'village', 'place', 'institution'],
  kind: ['event', 'use', 'making', 'meaning', 'inheritance', 'contact', 'appearance', 'absence'],
  stratum: ['made', 'lived', 'observed', 'present'],
  evidence: ['contemporary-document', 'later-account', 'physical-trace', 'inference', 'none'],
  role: ['witness', 'maker', 'descendant', 'community-authority', 'scholar', 'curator', 'contributor', 'passerby'],
  cause: ['never-collected', 'destroyed', 'suppressed', 'restricted', 'lost'],
  audience: ['family', 'community', 'team', 'public'],
  formKind: ['splat', 'photo', 'scan', 'reconstruction'],
};
// How directly each kind of upload records the thing (Form layer, reality basis).
const BASIS = { splat: 'recorded', photo: 'recorded', scan: 'recorded', reconstruction: 'symbolic' };
const FILE_EXT = { splat: /\.(sog|spz|ply|splat|ksplat)$/i, photo: /\.(jpe?g|png|webp)$/i, scan: /\.(glb|obj|stl|ply)$/i, reconstruction: /\.(glb|obj|stl)$/i };
const MAX_UPLOAD = 300 * 1024 * 1024;

export function createGather({ ROOT, s3, sendJson, readJson, mimeOf }) {
  const LOCAL = path.join(ROOT, 'data', 'gather');
  const KEYS = { envelopes: 'gather/envelopes.jsonl', observations: 'gather/observations.jsonl', forms: 'gather/forms.jsonl', translations: 'gather/translations.jsonl' };
  const localPath = (key) => path.join(LOCAL, ...key.split('/').slice(1));
  const s = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const newId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  async function readText(key) {
    if (!s3) { const f = localPath(key); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }
    try { return await (await s3.client.send(new s3.GetObjectCommand({ Bucket: s3.bucket, Key: key }))).Body.transformToString(); }
    catch (err) { if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return ''; throw err; }
  }
  async function writeText(key, text) {
    if (!s3) { const f = localPath(key); fs.mkdirSync(path.dirname(f), { recursive: true }); return fs.writeFileSync(f, text); }
    await s3.client.send(new s3.PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: text, ContentType: 'application/x-ndjson' }));
  }
  const rows = async (key) => (await readText(key)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  // Appends are serialised so two interviewers cannot overwrite each other's lines.
  let queue = Promise.resolve();
  function append(key, items) {
    const run = queue.then(async () => writeText(key, (await readText(key)) + items.map((i) => JSON.stringify(i)).join('\n') + '\n'));
    queue = run.catch(() => {});
    return run;
  }

  // ---- What the record still lacks, layer by layer (drives the next question)
  function missing(observations, forms) {
    const current = observations.filter((o) => !observations.some((x) => x.supersedes === o.id));
    const kinds = new Set(current.map((o) => o.kind)), strata = new Set(current.map((o) => o.stratum));
    const out = [];
    if (!forms.length) out.push('form: no photograph, scan or splat yet (ask whether there are photographs, or whether it may be photographed)');
    for (const st of ['made', 'lived', 'present']) if (!strata.has(st)) out.push(`time: nothing yet about ${{ made: 'how or when it was made or began', lived: 'the time it was in use', present: 'how it is now' }[st]}`);
    if (!current.some((o) => o.actors?.length)) out.push('actors: no people named yet (who made it, used it, looked after it)');
    for (const k of ['making', 'use', 'meaning', 'inheritance']) if (!kinds.has(k)) out.push(`observation types: nothing yet on ${{ making: 'how it was made', use: 'how it was used day to day', meaning: 'what it meant to people', inheritance: 'how it was passed on' }[k]}`);
    if (!kinds.has('absence')) out.push('absence: nothing recorded yet about what is no longer known, was never asked, or was lost');
    return { list: out, current };
  }

  // ---- Interview step: transcript -> draft observations + the next question
  const INTERVIEW_RULES = [
    'You help a volunteer interviewer record what an older resident of a Hokkaido town knows about one place or thing (an "envelope"). From the transcript of what the speaker just said, you do two jobs.',
    '',
    'JOB 1: observations. Split what the speaker said into separate observations.',
    '- Only what the speaker said. Never add facts, dates, names or explanations of your own. If you are not sure they said it, leave it out.',
    '- claim: one plain sentence in the session language, third person, close to their words.',
    '- quote: the speaker\'s own words for it, copied from the transcript, short.',
    '- kind: event (something that happened), use (how it was used), making (how it was made or built), meaning (what it meant to someone), inheritance (how it was passed on), contact (meeting between groups or outsiders), appearance (what it looks like), absence (see below).',
    '- stratum: made (when the thing was made, built or began), lived (the time it was in use, the time being remembered), observed (what people have said or done about it since), present (how it is now).',
    '- when: the time in the speaker\'s own words, copied, eight words at most ("around 1965", "when I was a child", "every winter"). Empty string if they gave none.',
    '- evidence: later-account for something remembered and told now; physical-trace when they point to something that can still be seen on the thing; contemporary-document when they refer to a letter, photograph or record made at the time; inference when they are guessing ("I think", "probably"); none for absences.',
    '- role: the speaker\'s standing for THIS claim: witness (saw or lived it), maker, descendant (heard it in the family), community-authority, contributor (hearsay or general knowledge), passerby.',
    '- actors: the people in it, named as the speaker named them ("my grandmother", "Sato the carpenter").',
    '- Absence: when the speaker says they do not know, nobody asked, it was lost or thrown away, it was not talked about, or it is not for outsiders, make an observation with kind absence and absenceCause: never-collected (nobody asked or recorded), destroyed, suppressed (people were made to stop), restricted (should not be shared widely), lost (the last person who knew is gone). absenceNote: their reason, in their words.',
    '- restricted: true when the speaker asks that something not be shared or be kept in the family.',
    '',
    'JOB 2: the next question, to be asked aloud.',
    '- In the session language, warm and plain, at most two short sentences. Open, not yes/no. Never leading, never suggesting an answer.',
    '- Choose from MISSING (what the record lacks), but follow the speaker\'s thread when they have just opened something worth following.',
    '- Do not press on painful subjects. If the speaker sounded tired or upset, offer to stop or change subject instead.',
    '- layer: which layer the question serves. why: one short line for the interviewer, in the session language.',
    'If the transcript is empty, return no observations and a gentle opening question about the envelope.',
    '',
    'MODE. When mode is "self" there is no interviewer: the person is entering their own memories at a kiosk, phone or computer and reads the question on the screen. Then: address the question to them directly ("you"), one short sentence, plain everyday words, no praise and no summary of what they said; write claims in the third person using their name if given, otherwise "the speaker" (Japanese: 話し手); and make why a short on-screen hint to the person about what kind of detail helps (for example "A year, a season or your age then is enough."), never a note about the record or its layers.',
  ].join('\n');
  const DRAFT_SCHEMA = {
    type: 'OBJECT',
    properties: {
      observations: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        claim: { type: 'STRING' }, quote: { type: 'STRING' }, kind: { type: 'STRING', enum: GATHER_ENUMS.kind },
        stratum: { type: 'STRING', enum: GATHER_ENUMS.stratum }, when: { type: 'STRING' },
        evidence: { type: 'STRING', enum: GATHER_ENUMS.evidence }, role: { type: 'STRING', enum: GATHER_ENUMS.role },
        actors: { type: 'ARRAY', items: { type: 'STRING' } },
        absenceCause: { type: 'STRING', enum: GATHER_ENUMS.cause }, absenceNote: { type: 'STRING' }, restricted: { type: 'BOOLEAN' },
      }, required: ['claim', 'quote', 'kind', 'stratum', 'evidence', 'role'], propertyOrdering: ['quote', 'claim', 'kind', 'stratum', 'when', 'evidence', 'role', 'actors', 'absenceCause', 'absenceNote', 'restricted'] } },
      next: { type: 'OBJECT', properties: {
        question: { type: 'STRING' }, why: { type: 'STRING' },
        layer: { type: 'STRING', enum: ['form', 'time', 'actors', 'types', 'evidence', 'absence', 'protocol'] },
      }, required: ['question', 'layer', 'why'] },
    },
    required: ['observations', 'next'],
  };
  async function interview(body) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) return { status: 503, data: { error: 'The interviewer assistant is not set up on this server (GEMINI_API_KEY is missing).' } };
    const envelope = (await rows(KEYS.envelopes)).find((e) => e.id === body.envelope);
    if (!envelope) return { status: 404, data: { error: 'Unknown envelope.' } };
    const lang = body.lang === 'ja' ? 'ja' : 'en';
    const observations = (await rows(KEYS.observations)).filter((o) => o.envelope === envelope.id);
    const forms = (await rows(KEYS.forms)).filter((f) => f.envelope === envelope.id);
    const { list, current } = missing(observations, forms);
    const input = {
      sessionLanguage: lang === 'ja' ? 'Japanese' : 'English',
      envelope: { name: envelope.name, scale: envelope.scale, place: envelope.place },
      mode: body.mode === 'self' ? 'self' : 'interviewer',
      speaker: { name: s(body.speaker?.name, 80) || 'the speaker', relation: s(body.speaker?.role, 40) },
      alreadyRecorded: current.slice(-40).map((o) => o.claim),
      MISSING: body.mode === 'self' ? list.filter((m) => !m.startsWith('form:')) : list, // self-entry has its own picture step
      lastQuestionAsked: s(body.lastQuestion, 400),
      transcript: s(body.transcript, 12000),
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GATHER_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash'}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INTERVIEW_RULES }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4000, responseMimeType: 'application/json', responseSchema: DRAFT_SCHEMA, thinkingConfig: { thinkingLevel: process.env.GATHER_THINKING || 'minimal' } },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) { console.error('gather gemini', res.status, (await res.text()).slice(0, 300)); return { status: 502, data: { error: 'The assistant could not read that just now. Your transcript is still here.' } }; }
    const out = await res.json();
    let parsed;
    try { parsed = JSON.parse(out.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''); }
    catch { return { status: 502, data: { error: 'The assistant could not read that just now. Your transcript is still here.' } }; }
    // Guard against runaway fields: a time phrase is short, a claim is a sentence or two.
    const tidy = (parsed.observations || []).filter((o) => o.claim && o.claim.length < 600).map((o) => ({ ...o, when: (o.when || '').length > 80 ? '' : (o.when || ''), quote: (o.quote || '').slice(0, 600) }));
    return { status: 200, data: { observations: tidy, next: parsed.next, missing: list } };
  }

  // ---- Intake: a person says what it is and who they are; this fills the form fields from their words
  const INTAKE_RULES = [
    'A person is starting to record a memory about a place or a thing, and has just spoken. From the transcript, pick out only these details, and only when they were actually said. Never guess. Use "unknown" or an empty string for anything not said.',
    '- name: what they call the place or thing, short, as they said it ("the old net shed"). Keep the language they spoke. No town name in it unless it is part of the name.',
    '- scale: keepsake (an object you can hold or keep), room, building, neighborhood, village, place (outdoor spot, landscape, street), institution (school, shrine, shop, company), or unknown.',
    '- place: the town or place where it is, as said.',
    '- speakerName: their own name, only if they gave it. declinedName: true if they said they would rather not give a name.',
    '- role: how they know about it: witness (saw, used or lived it themselves), maker (made or built it), descendant (heard it in their family), community-authority (speaks for a community group), contributor (heard it from others), passerby (knows only a little), or unknown.',
    '- audience: who may see what they tell, only if they said: family, community, team (the project staff), public (anyone), or unknown.',
    '- story: true if they also told memories or facts about it beyond these details.',
    'ASKED is the question they were just asked, and HAVE is what is already filled in. A short reply is the answer to ASKED and nothing else: after "Where is it?", "down by the harbour in Yoichi" is the place, not a new name. Return a detail that is already in HAVE only when the person is plainly correcting it; otherwise leave it empty or unknown. Give role only when they say how they know about it, not from a word like "my grandfather’s" in the name.',
  ].join('\n');
  const withUnknown = (list) => [...list, 'unknown'];
  const INTAKE_SCHEMA = { type: 'OBJECT', properties: {
    name: { type: 'STRING' }, scale: { type: 'STRING', enum: withUnknown(GATHER_ENUMS.scale) }, place: { type: 'STRING' },
    speakerName: { type: 'STRING' }, declinedName: { type: 'BOOLEAN' }, role: { type: 'STRING', enum: withUnknown(GATHER_ENUMS.role) },
    audience: { type: 'STRING', enum: withUnknown(GATHER_ENUMS.audience) }, story: { type: 'BOOLEAN' },
  }, required: ['name', 'scale', 'place', 'speakerName', 'role', 'audience', 'story'], propertyOrdering: ['name', 'scale', 'place', 'speakerName', 'declinedName', 'role', 'audience', 'story'] };
  async function intake(body) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) return { status: 503, data: { error: 'The assistant is not set up on this server (GEMINI_API_KEY is missing).' } };
    const transcript = s(body.transcript, 4000);
    if (!transcript) return { status: 400, data: { error: 'Nothing was heard.' } };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GATHER_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash'}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INTAKE_RULES }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ ASKED: s(body.asked, 300), HAVE: body.have && typeof body.have === 'object' ? Object.fromEntries(Object.entries(body.have).slice(0, 8).map(([k, v]) => [s(k, 20), s(v, 160)])) : {}, transcript }) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 600, responseMimeType: 'application/json', responseSchema: INTAKE_SCHEMA, thinkingConfig: { thinkingLevel: process.env.GATHER_THINKING || 'minimal' } },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) { console.error('gather intake', res.status, (await res.text()).slice(0, 300)); return { status: 502, data: { error: 'Could not read that just now. You can type it in below.' } }; }
    let p;
    try { p = JSON.parse((await res.json()).candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || ''); }
    catch { return { status: 502, data: { error: 'Could not read that just now. You can type it in below.' } }; }
    const known = (v, list) => (list.includes(v) ? v : '');
    return { status: 200, data: {
      name: s(p.name, 160), scale: known(p.scale, GATHER_ENUMS.scale), place: s(p.place, 160),
      speakerName: s(p.speakerName, 120), declinedName: p.declinedName === true, role: known(p.role, GATHER_ENUMS.role),
      audience: known(p.audience, GATHER_ENUMS.audience), story: p.story === true } };
  }

  // ---- Viewer: the other language. What was said stays as recorded; a machine translation is kept beside it, cached, and labelled.
  const langOf = (text) => (/[\u3040-\u30ff\u4e00-\u9fff]/.test(text || '') ? 'ja' : 'en');
  const TRANSLATE_RULES = [
    'Translate each string into the target language. Return every item with the same id and the same number of strings in the same order. An empty string stays empty.',
    'These are short records of what older residents of a Hokkaido town said about a place or a thing. Translate plainly and faithfully: add nothing, explain nothing, keep uncertainty ("I think", "around") as it is.',
    'Names of people and places: into English, romanise them; into Japanese, keep Japanese names in their usual writing and put foreign names in katakana. Era dates such as 昭和三十年ごろ become "around Showa 30 (1955)" in English. Going into Japanese, keep a Western year as a Western year (1955年ごろ); never add an era name that was not said.',
  ].join('\n');
  // items: [{ id, strings: [...] }] -> Map id -> translated strings (from the cache where possible)
  async function translate(items, to) {
    const out = new Map();
    if (!items.length) return out;
    const cached = await rows(KEYS.translations);
    for (const c of cached) if (c.to === to) out.set(c.id, c.strings);
    const need = items.filter((i) => !out.has(i.id) && i.strings.some(Boolean)).slice(0, 80);
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!need.length || !key) return out;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GATHER_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash'}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: TRANSLATE_RULES }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify({ targetLanguage: to === 'ja' ? 'Japanese' : 'English', items: need }) }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8000, responseMimeType: 'application/json',
            responseSchema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, strings: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['id', 'strings'] } },
            thinkingConfig: { thinkingLevel: process.env.GATHER_THINKING || 'minimal' } },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) { console.error('gather translate', res.status, (await res.text()).slice(0, 300)); return out; }
      const parsed = JSON.parse((await res.json()).candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '[]');
      const fresh = [];
      for (const p of parsed) {
        const src = need.find((n) => n.id === p.id);
        if (!src || !Array.isArray(p.strings) || p.strings.length !== src.strings.length) continue;
        const strings = p.strings.map((x) => s(x, 2000));
        out.set(p.id, strings); fresh.push({ id: p.id, to, strings, machine: true, createdAt: new Date().toISOString() });
      }
      if (fresh.length) await append(KEYS.translations, fresh);
    } catch (err) { console.error('gather translate', err.message); }
    return out;
  }
  const currentOf = (observations) => observations.filter((o) => !observations.some((x) => x.supersedes === o.id));
  async function gallery(lang) {
    const [envelopes, observations, forms] = await Promise.all([rows(KEYS.envelopes), rows(KEYS.observations), rows(KEYS.forms)]);
    const tr = await translate(envelopes.filter((e) => langOf(e.name) !== lang).map((e) => ({ id: e.id, strings: [e.name, e.place || ''] })), lang);
    return envelopes.map((e) => {
      const obs = currentOf(observations.filter((o) => o.envelope === e.id)), fs = forms.filter((x) => x.envelope === e.id);
      const other = langOf(e.name) !== lang && tr.get(e.id);
      return { id: e.id, name: e.name, place: e.place || '', scale: e.scale, parent: e.parent || '', audience: e.audience, createdAt: e.createdAt, lang: langOf(e.name),
        tr: other ? { name: other[0], place: other[1] } : null,
        observations: obs.length, publicObservations: obs.filter((o) => o.protocol?.audience === 'public').length,
        thumb: fs.find((x) => x.kind === 'photo')?.file || '', thumbPublic: fs.find((x) => x.kind === 'photo' && x.protocol?.audience === 'public')?.file || '',
        forms: [...new Set(fs.map((x) => x.kind))] };
    }).reverse();
  }
  async function item(id, lang) {
    const envelope = (await rows(KEYS.envelopes)).find((e) => e.id === id);
    if (!envelope) return null;
    const all = (await rows(KEYS.observations)).filter((o) => o.envelope === id);
    const observations = currentOf(all), forms = (await rows(KEYS.forms)).filter((x) => x.envelope === id);
    const pack = (o) => [o.claim, o.when || '', o.absence?.note || '', ...(o.actors || [])];
    const want = observations.filter((o) => (o.lang || langOf(o.claim)) !== lang).map((o) => ({ id: o.id, strings: pack(o) }));
    if (langOf(envelope.name) !== lang) want.push({ id: envelope.id, strings: [envelope.name, envelope.place || ''] });
    for (const x of forms) if (x.caption && langOf(x.caption) !== lang) want.push({ id: x.id, strings: [x.caption] });
    const tr = await translate(want, lang);
    const e = tr.get(envelope.id);
    return {
      envelope: { ...envelope, lang: langOf(envelope.name), tr: langOf(envelope.name) !== lang && e ? { name: e[0], place: e[1] } : null },
      forms: forms.map((x) => ({ ...x, tr: x.caption && langOf(x.caption) !== lang && tr.get(x.id) ? { caption: tr.get(x.id)[0] } : null })),
      observations: observations.map((o) => {
        const x = (o.lang || langOf(o.claim)) !== lang && tr.get(o.id);
        let earlier = 0; for (let p = o; p?.supersedes; p = all.find((y) => y.id === p.supersedes)) earlier++;
        return { ...o, earlier, tr: x ? { claim: x[0], when: x[1], note: x[2], actors: x.slice(3) } : null };
      }),
    };
  }

  function cleanObservation(o, session, existing) {
    const errors = [];
    const out = {
      id: newId('gobs'), envelope: session.envelope, kind: s(o.kind, 40), stratum: s(o.stratum, 40), when: s(o.when, 120),
      claim: s(o.claim), quote: s(o.quote, 600), evidence: s(o.evidence, 40),
      standing: { role: s(o.role, 40), grantedBy: s(session.grantedBy, 200) },
      actors: Array.isArray(o.actors) ? o.actors.map((a) => s(a, 120)).filter(Boolean).slice(0, 12) : [],
      speaker: s(session.speaker, 120) || 'Anonymous',
      protocol: { audience: s(o.audience, 20) || s(session.audience, 20) || 'family' },
      via: session.mode === 'self' ? 'self' : 'interview',
      source: { type: 'testimony', ref: session.mode === 'self'
        ? `Told directly by ${s(session.speaker, 120) || 'an anonymous speaker'}, ${new Date().toISOString().slice(0, 10)}`
        : `Interview with ${s(session.speaker, 120) || 'an anonymous speaker'}, ${new Date().toISOString().slice(0, 10)}, recorded by ${s(session.interviewer, 120)}` },
      author: session.mode === 'self' ? (s(session.speaker, 120) || 'Anonymous') : s(session.interviewer, 120), lang: session.lang === 'ja' ? 'ja' : 'en', status: 'unverified', createdAt: new Date().toISOString(),
    };
    if (!out.claim) errors.push('claim');
    for (const [f, list] of [['kind', GATHER_ENUMS.kind], ['stratum', GATHER_ENUMS.stratum], ['evidence', GATHER_ENUMS.evidence]]) if (!list.includes(out[f])) errors.push(f);
    if (!GATHER_ENUMS.role.includes(out.standing.role)) errors.push('standing');
    if (!GATHER_ENUMS.audience.includes(out.protocol.audience)) errors.push('audience');
    if (out.kind === 'absence') {
      out.absence = { cause: s(o.absenceCause, 40), note: s(o.absenceNote, 500) };
      if (!GATHER_ENUMS.cause.includes(out.absence.cause)) errors.push('absence cause');
    }
    if (o.supersedes) { out.supersedes = s(o.supersedes, 80); if (!existing.some((e) => e.id === out.supersedes)) errors.push('supersedes'); }
    return { errors, out };
  }

  async function sendFile(res, key) {
    const headers = { 'content-type': mimeOf(key), 'cache-control': 'private, max-age=3600' };
    if (!s3) {
      const f = localPath(key);
      if (!f.startsWith(LOCAL + path.sep) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ...headers, 'content-length': fs.statSync(f).size });
      return fs.createReadStream(f).pipe(res);
    }
    try {
      const out = await s3.client.send(new s3.GetObjectCommand({ Bucket: s3.bucket, Key: key }));
      res.writeHead(200, { ...headers, ...(out.ContentLength != null && { 'content-length': out.ContentLength }) });
      Readable.fromWeb(out.Body.transformToWebStream()).pipe(res);
    } catch { res.writeHead(404); res.end(); }
  }

  async function upload(req, res, q) {
    const envelope = (await rows(KEYS.envelopes)).find((e) => e.id === q.get('envelope'));
    const kind = q.get('kind');
    const name = path.basename(s(q.get('name'), 120)).replace(/[^\w.\-]+/g, '_');
    const length = Number(req.headers['content-length']);
    if (!envelope) return sendJson(res, 404, { error: 'Unknown envelope.' });
    if (!GATHER_ENUMS.formKind.includes(kind) || !FILE_EXT[kind].test(name)) return sendJson(res, 400, { error: 'That file type does not fit this kind of upload.' });
    if (!length) return sendJson(res, 411, { error: 'Missing file size.' });
    if (length > MAX_UPLOAD) return sendJson(res, 413, { error: 'File too large (300 MB at most).' });
    const key = `gather/files/${envelope.id}/${Date.now().toString(36)}-${name}`;
    if (s3) await s3.client.send(new s3.PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: req, ContentLength: length, ContentType: mimeOf(name) }));
    else { const f = localPath(key); fs.mkdirSync(path.dirname(f), { recursive: true }); await pipeline(req, fs.createWriteStream(f)); }
    const form = {
      id: newId('gform'), envelope: envelope.id, kind, basis: BASIS[kind], file: key.slice('gather/files/'.length), name, size: length,
      caption: s(q.get('caption'), 300), captured: { date: s(q.get('date'), 40), by: s(q.get('by'), 120) },
      protocol: { audience: GATHER_ENUMS.audience.includes(q.get('audience')) ? q.get('audience') : envelope.audience || 'family' },
      createdAt: new Date().toISOString(),
    };
    await append(KEYS.forms, [form]);
    return sendJson(res, 201, form);
  }

  async function handle(req, res, pathname) {
    const q = new URL(req.url, 'http://x').searchParams;
    const route = pathname.slice('/api/gather/'.length);
    if (route === 'enums' && req.method === 'GET') return sendJson(res, 200, { ...GATHER_ENUMS, basis: BASIS });
    if (route === 'envelopes' && req.method === 'GET') return sendJson(res, 200, await rows(KEYS.envelopes));
    if (route === 'envelopes' && req.method === 'POST') {
      const b = await readJson(req);
      const env = { id: newId('env'), name: s(b.name, 160), scale: s(b.scale, 40), place: s(b.place, 160), parent: s(b.parent, 80), note: s(b.note, 600),
        audience: GATHER_ENUMS.audience.includes(b.audience) ? b.audience : 'family', createdBy: s(b.createdBy, 120), createdAt: new Date().toISOString() };
      if (!env.name || !GATHER_ENUMS.scale.includes(env.scale)) return sendJson(res, 400, { error: 'An envelope needs a name and a scale.' });
      if (!env.parent) delete env.parent;
      await append(KEYS.envelopes, [env]);
      return sendJson(res, 201, env);
    }
    if (route === 'envelope' && req.method === 'GET') {
      const id = q.get('id');
      const envelope = (await rows(KEYS.envelopes)).find((e) => e.id === id);
      if (!envelope) return sendJson(res, 404, { error: 'Unknown envelope.' });
      const observations = (await rows(KEYS.observations)).filter((o) => o.envelope === id);
      const forms = (await rows(KEYS.forms)).filter((f) => f.envelope === id);
      return sendJson(res, 200, { envelope, observations, forms, missing: missing(observations, forms).list });
    }
    if (route === 'gallery' && req.method === 'GET') return sendJson(res, 200, await gallery(q.get('lang') === 'ja' ? 'ja' : 'en'));
    if (route === 'item' && req.method === 'GET') {
      const data = await item(q.get('id'), q.get('lang') === 'ja' ? 'ja' : 'en');
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: 'Unknown envelope.' });
    }
    if (route === 'intake' && req.method === 'POST') {
      const { status, data } = await intake(await readJson(req, 20000));
      return sendJson(res, status, data);
    }
    if (route === 'interview' && req.method === 'POST') {
      const { status, data } = await interview(await readJson(req, 40000));
      return sendJson(res, status, data);
    }
    if (route === 'observations' && req.method === 'POST') {
      const b = await readJson(req, 200000);
      const session = b.session || {};
      if (!(await rows(KEYS.envelopes)).some((e) => e.id === session.envelope)) return sendJson(res, 404, { error: 'Unknown envelope.' });
      if (session.consent !== true) return sendJson(res, 400, { error: 'Record the speaker\'s consent before saving.' });
      if (session.mode !== 'self' && !s(session.interviewer, 120)) return sendJson(res, 400, { error: 'Add your own name as the interviewer.' });
      const existing = await rows(KEYS.observations);
      const cleaned = (Array.isArray(b.items) ? b.items : []).slice(0, 60).map((o) => cleanObservation(o, session, existing));
      const bad = cleaned.find((c) => c.errors.length);
      if (!cleaned.length) return sendJson(res, 400, { error: 'Nothing to save.' });
      if (bad) return sendJson(res, 400, { error: `Check: ${bad.errors.join(', ')} ("${bad.out.claim.slice(0, 40)}…")` });
      await append(KEYS.observations, cleaned.map((c) => c.out));
      return sendJson(res, 201, { saved: cleaned.length });
    }
    if (route === 'upload' && req.method === 'PUT') return upload(req, res, q);
    if (route.startsWith('file/') && req.method === 'GET') {
      const rel = route.slice(5);
      if (!/^env-[a-z0-9-]+\/[\w.\-]+$/.test(rel)) { res.writeHead(400); return res.end(); }
      return sendFile(res, `gather/files/${rel}`);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }
  return { handle };
}
