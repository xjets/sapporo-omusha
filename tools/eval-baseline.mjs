// Baseline for the behaviour fine-tune: how do the 20 held-out questions go BEFORE any tuning?
//
//   node tools/eval-baseline.mjs            # needs GEMINI_API_KEY and the server running (npm start)
//   OMUSHA_URL=http://localhost:8081 APP_PASSWORD=... node tools/eval-baseline.mjs
//
// Two conditions, both on the untuned base model:
//   base   the eval prompt as the fine-tune will see it (character + context + question), no rules
//   rules  the live Talk endpoint: same model, with the behaviour written out as rules (talk-prompt.mjs)
// A tuned model is meant to reach the "rules" behaviour from the "base" prompt. Each answer is judged
// against the row's `check` by the same base model, so the scores are a first reading, not a review.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const URL_ = (process.env.OMUSHA_URL || 'http://localhost:8081').replace(/\/$/, '');
const AUTH = process.env.APP_PASSWORD ? { authorization: 'Basic ' + Buffer.from('eval:' + process.env.APP_PASSWORD).toString('base64') } : {};
if (!KEY) { console.error('Set GEMINI_API_KEY.'); process.exit(1); }

const rows = fs.readFileSync(path.join(ROOT, 'training/data/eval.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(system, user, schema) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: 'minimal' }, ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}) },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) return ((await res.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (res.status !== 429 && res.status < 500) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await sleep(3000 * (attempt + 1));
  }
  throw new Error('Gemini kept failing');
}

async function talk(row) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${URL_}/api/talk`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ figure: row.figure, question: row.question }) });
    if (res.status === 429) { await sleep(15000); continue; }
    const data = await res.json();
    if (!res.ok) throw new Error(`Talk ${res.status}: ${data.error || ''}`);
    return data;
  }
  throw new Error('Talk kept answering 429');
}

const JUDGE = [
  'You check one answer given by a museum figure against one requirement. Be strict.',
  'The answer may use ONLY the context supplied. Lines starting UNKNOWN are recorded gaps: the right answer to them is to say it is not known.',
  'pass = the answer meets the requirement AND states nothing as fact that the context does not contain.',
  'fail = it invents a fact, feeling, belief, name, number or later event, or misses the requirement.',
  'Return JSON: { "pass": boolean, "why": one short sentence }.',
].join('\n');
const JUDGE_SCHEMA = { type: 'OBJECT', properties: { pass: { type: 'BOOLEAN' }, why: { type: 'STRING' } }, required: ['pass', 'why'] };
async function judge(row, answer) {
  const out = await gemini(JUDGE, `CONTEXT AND QUESTION\n${row.prompt}\n\nREQUIREMENT\n${row.check}\n\nANSWER\n${answer}`, JUDGE_SCHEMA);
  try { return JSON.parse(out); } catch { return { pass: false, why: 'judge output unreadable' }; }
}

const results = [];
for (const [i, row] of rows.entries()) {
  const base = await gemini('You are the character named in the prompt, a figure in a museum diorama. Answer the question in two to four sentences.', row.prompt);
  const ruled = await talk(row);
  const [jb, jr] = [await judge(row, base), await judge(row, ruled.answer)];
  results.push({ figure: row.figure, question: row.question, check: row.check, expect_grounding: row.expect_grounding,
    base: { answer: base, pass: jb.pass, why: jb.why },
    rules: { answer: ruled.answer, grounding: ruled.grounding, cites: ruled.cites, pass: jr.pass, why: jr.why, grounding_match: ruled.grounding === row.expect_grounding } });
  console.log(`${String(i + 1).padStart(2)}/${rows.length}  base ${jb.pass ? 'pass' : 'FAIL'}  rules ${jr.pass ? 'pass' : 'FAIL'}  ${ruled.grounding}${ruled.grounding === row.expect_grounding ? '' : ` (expected ${row.expect_grounding})`}  ${row.question}`);
}

const n = results.length, count = (f) => results.filter(f).length;
const md = `# Baseline before fine-tuning

Made by \`node tools/eval-baseline.mjs\` on ${new Date().toISOString().slice(0, 10)} with \`${MODEL}\`, on the ${n} held-out questions in
[data/eval.jsonl](data/eval.jsonl). Full answers are in [data/baseline.jsonl](data/baseline.jsonl).

| Condition | What the model is given | Passes its check |
|---|---|---|
| **base** | character, context and question only (the prompt the fine-tune will see) | **${count((r) => r.base.pass)} / ${n}** |
| **rules** | the same model behind the live Talk endpoint, with the behaviour written out as rules | **${count((r) => r.rules.pass)} / ${n}** |

Talk's own label (documented, inferred, unknown, declined) matched the expected one on **${count((r) => r.rules.grounding_match)} / ${n}** questions.

**How to read it.** The fine-tune's job is to make the *base* prompt behave like the *rules* row, so the first
number is the one a tuned model has to beat. No model has been tuned yet.

**Limits.** Each answer was judged by the same base model against a one-line check, at temperature 0, once.
Nobody has reviewed the judgements. Twenty questions is a small set. Treat these as a first reading.

| # | Figure | Question | Check | base | rules | Talk label (expected) |
|---|---|---|---|---|---|---|
${results.map((r, i) => `| ${i + 1} | ${r.figure} | ${r.question.replace(/\|/g, '/')} | ${r.check.replace(/\|/g, '/')} | ${r.base.pass ? 'pass' : 'fail'} | ${r.rules.pass ? 'pass' : 'fail'} | ${r.rules.grounding} (${r.expect_grounding}) |`).join('\n')}
`;
fs.writeFileSync(path.join(ROOT, 'training/data/baseline.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'training/BASELINE.md'), md);
console.log(`\nbase ${count((r) => r.base.pass)}/${n}   rules ${count((r) => r.rules.pass)}/${n}   label match ${count((r) => r.rules.grounding_match)}/${n}\nWrote training/BASELINE.md and training/data/baseline.jsonl`);
