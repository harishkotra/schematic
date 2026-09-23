/**
 * Reliability probe: how often does each local model actually produce Mermaid that parses?
 *
 * The app's entire thesis is that plausible-looking architecture diagrams are often
 * broken, so it is worth measuring rather than assuming. Each model is asked the exact
 * brief N times, sequentially (LM Studio cannot serve two requests at once), and each
 * reply is put through the server's real validator.
 *
 * Usage: npx tsx verify/probe-reliability.mts [attempts]
 */
import { extractMermaid } from '../server/src/extract.js';

const LM = 'http://127.0.0.1:1234/v1';
const API = 'http://127.0.0.1:3001';
const ATTEMPTS = Number.parseInt(process.argv[2] ?? '3', 10);

const MODELS = (process.env.PROBE_MODELS ?? 'openai/gpt-oss-20b,google/gemma-4-12b,google/gemma-4-e4b,zai-org/glm-4.7-flash,meta/muse-glimmer,ornith-1.0-35b').split(',');

const BRIEFS = (process.env.PROBE_BRIEFS ?? 'a URL shortener at 10M clicks/day').split('|');

/**
 * Byte-for-byte the prompt the app sends, nonce line included. This matters: a
 * nonce-bearing prompt measurably changes what small models emit, so probing without it
 * would pick demo models that do not work in the real app.
 */
const PROMPT = (brief: string, nonce: string) => [
  `Design the architecture for ${brief}.`,
  '',
  'Output ONE Mermaid flowchart. Output only the Mermaid source in a ```mermaid fence. Label every component and every edge.',
  '',
  `(request nonce: ${nonce} — ignore this line)`,
].join('\n');

const nonce = () => Math.random().toString(16).slice(2, 14);

interface Outcome {
  model: string;
  brief: number;
  attempt: number;
  http: number | string;
  seconds: number;
  path: string;
  parseOk: boolean;
  nodes: number;
  edges: number;
  error: string;
}

const outcomes: Outcome[] = [];

for (const model of MODELS) {
  for (let briefIndex = 0; briefIndex < BRIEFS.length; briefIndex++) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const t0 = Date.now();
      let http: number | string = 'ERR';
      let content = '';
      try {
        const res = await fetch(`${LM}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: "You are a precise assistant. Answer the user's request directly." },
              { role: 'user', content: PROMPT(BRIEFS[briefIndex]) },
            ],
            temperature: 0,
            max_tokens: 1600,
            stream: false,
          }),
          signal: AbortSignal.timeout(600_000),
        });
        http = res.status;
        const text = await res.text();
        try {
          content = (JSON.parse(text) as any)?.choices?.[0]?.message?.content ?? '';
        } catch {
          content = '';
        }
      } catch (err) {
        http = `ERR`;
      }

      const seconds = Math.round((Date.now() - t0) / 1000);
      const extraction = extractMermaid(content);
      let parseOk = false;
      let nodes = 0;
      let edges = 0;
      let error = '';

      if (extraction.source) {
        const res = await fetch(`${API}/api/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mermaid: extraction.source }),
        });
        const v = (await res.json()) as any;
        parseOk = v.parseOk === true;
        if (parseOk) {
          nodes = v.counts.nodes;
          edges = v.counts.edges;
        } else {
          error = String(v.parseError?.message ?? '').split('\n')[0];
        }
      } else {
        error = content ? 'no diagram in reply' : 'empty content';
      }

      outcomes.push({ model, brief: briefIndex + 1, attempt, http, seconds, path: extraction.path, parseOk, nodes, edges, error });
      console.log(
        `${parseOk ? 'OK  ' : 'FAIL'} ${model.padEnd(22)} brief${briefIndex + 1} try${attempt} ` +
          `HTTP ${http} ${seconds}s ${extraction.path.padEnd(13)} ` +
          (parseOk ? `${nodes}n/${edges}e` : error.slice(0, 80)),
      );
    }
  }
}

console.log('\n── parse rate per model ──');
for (const model of MODELS) {
  const rows = outcomes.filter((o) => o.model === model);
  const ok = rows.filter((o) => o.parseOk).length;
  const avg = Math.round(rows.reduce((n, r) => n + r.seconds, 0) / rows.length);
  console.log(
    `${model.padEnd(22)} ${ok}/${rows.length} parsed (${Math.round((ok / rows.length) * 100)}%) · avg ${avg}s`,
  );
}

console.log('\n── distinct failure modes ──');
const failures = new Map<string, number>();
for (const o of outcomes.filter((o) => !o.parseOk)) {
  const key = `${o.model}: ${o.error.slice(0, 70)}`;
  failures.set(key, (failures.get(key) ?? 0) + 1);
}
for (const [key, count] of [...failures.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}× ${key}`);
}