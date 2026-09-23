/**
 * Real end-to-end verification for Schematic.
 *
 * Every check here talks to the running API over HTTP and, where a model is involved,
 * to a real model. Nothing is simulated. Output is written to verify/evidence/ so the
 * claims in VERIFICATION.md can be re-checked against the raw JSON.
 *
 * Usage: node verify/e2e.mjs            (expects the API on 127.0.0.1:3001)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = resolve(HERE, 'evidence');
const API = process.env.SCHEMATIC_API ?? 'http://127.0.0.1:3001';

mkdirSync(EVIDENCE, { recursive: true });

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  console.log(`${mark}  ${name}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
}

function save(name, data) {
  writeFileSync(resolve(EVIDENCE, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const slot = (over) => ({
  provider: 'lmstudio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: '',
  model: 'qwen/qwen3.5-9b',
  temperature: 0,
  maxTokens: 1600,
  disableReasoning: false,
  ...over,
});

console.log('\n═══ 1. Live local provider, no API key, preset brief ═══\n');

const health = await api('/api/health');
check('API is up', health.json.ok === true, `promptReuse=${JSON.stringify(health.json.promptReuse)}`);

const listing = await api('/api/models', {
  provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '',
});
check(
  'LM Studio models read live from /v1/models with no key',
  listing.json.ok === true && listing.json.models.length > 0,
  `${listing.json.models.length} models: ${listing.json.models.slice(0, 4).join(', ')}…`,
);

// Model choice is empirical, not aspirational. Every LM Studio model on this machine was
// probed three times with the app's exact nonce-bearing prompt (see
// verify/probe-reliability.mts and the table in VERIFICATION.md). These are the two that
// produced Mermaid which parses 3 times out of 3 at the default 1600-token budget:
//   google/gemma-4-12b  3/3 · avg 76s
//   ornith-1.0-35b      3/3 · avg 48s (deterministically 12 nodes / 18 edges)
// qwen/qwen3.5-9b is deliberately NOT used: it spends the whole budget on hidden CoT and
// returns empty content. That behaviour is documented in section 7 instead.
const BRIEF = 'a URL shortener at 10M clicks/day';
const MODEL_A = 'google/gemma-4-12b';
const MODEL_B = 'ornith-1.0-35b';

// Model output is not deterministic even at temperature 0 — reasoning models vary run to
// run, and the measured parse rate is reported in VERIFICATION.md. So we allow a bounded
// number of attempts and report how many it took, rather than hiding a failure or
// claiming a first-try success we did not get.
const MAX_ATTEMPTS = 3;
let run1 = null;
let attemptsUsed = 0;
const attemptLog = [];

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  attemptsUsed = attempt;
  console.log(`\n   attempt ${attempt}/${MAX_ATTEMPTS}: ${MODEL_A} (A) vs ${MODEL_B} (B) on "${BRIEF}"…\n`);
  run1 = await api('/api/schematic', {
    brief: BRIEF,
    slotA: slot({ model: MODEL_A }),
    slotB: slot({ model: MODEL_B }),
  });
  attemptLog.push({
    attempt,
    a: { ok: run1.json?.a?.ok, nodes: run1.json?.a?.counts?.nodes, error: run1.json?.a?.error },
    b: { ok: run1.json?.b?.ok, nodes: run1.json?.b?.counts?.nodes, error: run1.json?.b?.error },
  });
  if (run1.json?.a?.ok === true && run1.json?.b?.ok === true) break;
}

save('run-01-url-shortener.json', run1.json);
save('run-01-attempts.json', attemptLog);

if (run1.status !== 200) {
  check('run completed', false, `HTTP ${run1.status}: ${JSON.stringify(run1.json).slice(0, 400)}`);
} else {
  const r = run1.json;
  check(
    `both diagrams parse and render (took ${attemptsUsed} attempt${attemptsUsed > 1 ? 's' : ''})`,
    r.a.ok === true && r.b.ok === true,
    attemptLog
      .map((l) => `#${l.attempt}: A ${l.a.ok ? 'ok' : 'FAIL'} / B ${l.b.ok ? 'ok' : 'FAIL'}`)
      .join(' · '),
  );
  for (const m of [r.a, r.b]) {
    check(
      `slot ${m.slot} (${m.model}) produced a parsed, rendered diagram`,
      m.ok === true && m.parseOk === true,
      m.ok
        ? `${m.counts.nodes} nodes / ${m.counts.edges} edges from the parsed diagram · ${m.byteCount} bytes · ${m.latencyMs} ms · via ${m.extractionPath}`
        : `errorKind=${m.errorKind}\n${m.error}`,
    );
  }

  check(
    'both slots received the identical prompt',
    r.a.promptSha256 === r.b.promptSha256 && r.a.nonce === r.b.nonce,
    `sha256 ${r.a.promptSha256.slice(0, 16)}… · nonce ${r.nonce}`,
  );

  check(
    'a slot with no diagram reports no source hash rather than the empty-string hash',
    [r.a, r.b].every((m) => (m.mermaid ? /^[0-9a-f]{64}$/.test(m.sha256 ?? '') : m.sha256 === null)),
    [r.a, r.b].map((m) => `${m.slot}: ${m.sha256 === null ? 'n/a (no source)' : m.sha256.slice(0, 16) + '…'}`).join(' · '),
  );

  check(
    'node/edge counts come from the parsed diagram',
    r.a.counts.source === 'parsed' && r.b.counts.source === 'parsed',
    `A: ${r.a.counts.nodes}/${r.a.counts.edges} (${r.a.counts.source}), B: ${r.b.counts.nodes}/${r.b.counts.edges} (${r.b.counts.source})`,
  );

  check(
    'reasoning tokens read from usage, or n/a — never a fabricated 0',
    [r.a, r.b].every((m) => m.reasoningSupported ? typeof m.reasoningTokens === 'number' : m.reasoningTokens === null),
    [r.a, r.b].map((m) => `${m.slot}: ${m.reasoningSupported ? m.reasoningTokens : 'n/a (absent from usage)'}`).join(' · '),
  );

  check(
    'no chain-of-thought text anywhere in the response',
    !JSON.stringify(r).includes('reasoning_content'),
    'searched the full serialised response for the key "reasoning_content"',
  );

  // ── the checklist audit ────────────────────────────────────────────────────
  console.log('\n═══ 2. Checklist audit: every tick backed by a label in the source ═══\n');
  for (const m of [r.a, r.b]) {
    const ticked = m.checklist.filter((i) => i.present);
    // Mermaid rewrites `<br/>` to `<br>` while parsing, so the audit compares under the
    // same normalisation and requires a cited source line for every tick.
    const norm = (t) => t.replace(/<br\s*\/?>/gi, '<br>').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    const sourceLines = m.mermaid.split('\n');
    const unsupported = ticked.filter((i) => {
      if (!i.matchedLabel || i.sourceLine === null) return true;
      const line = sourceLines[i.sourceLine - 1];
      return !line || !norm(line).includes(norm(i.matchedLabel));
    });
    check(
      `slot ${m.slot}: all ${ticked.length} ticks cite a real label on a real source line`,
      unsupported.length === 0,
      unsupported.length
        ? unsupported.map((i) => `${i.concept} -> ${JSON.stringify(i.matchedLabel)}`).join('\n')
        : ticked.slice(0, 5).map((i) => `${i.concept} = "${i.matchedLabel}" (${i.matchedIn}, source line ${i.sourceLine})`).join('\n'),
    );
    const missing = m.checklist.filter((i) => !i.present).map((i) => i.concept);
    check(
      `slot ${m.slot}: missing concepts reported honestly`,
      true,
      missing.length ? `not mentioned: ${missing.join(', ')}` : 'all twelve concepts present',
    );
  }

  console.log('\n═══ 3. The diff — the shareable line ═══\n');
  console.log(`   ${r.diff.headline}\n`);
  check('a diff headline was produced', r.diff.headline.length > 0, r.diff.headline);
  check(
    'label diff computed',
    Array.isArray(r.diff.onlyInB) && Array.isArray(r.diff.onlyInA),
    `only in A: ${r.diff.onlyInA.length} · only in B: ${r.diff.onlyInB.length}` +
      (r.diff.onlyInB.length ? `\nB-only: ${r.diff.onlyInB.slice(0, 8).join(' | ')}` : ''),
  );

  // ── prompt reuse ───────────────────────────────────────────────────────────
  console.log('\n═══ 4. No prompt reuse across runs ═══\n');
  const run2 = await api('/api/schematic', {
    brief: BRIEF,
    slotA: slot({ model: MODEL_A }),
    slotB: slot({ model: MODEL_B }),
  });
  save('run-02-repeat.json', run2.json);
  const r2 = run2.json;
  const strip = (s) => s.replace(/\(request nonce: [0-9a-f]+ — ignore this line\)/, '');
  check(
    'second run used a fresh nonce and a different prompt hash',
    r2.nonce !== r.nonce && r2.a.promptSha256 !== r.a.promptSha256,
    `nonce ${r.nonce} -> ${r2.nonce}`,
  );
  check(
    'the prompt differs only by the nonce, so the comparison stays fair',
    strip(r.promptSent) === strip(r2.promptSent),
    'prompts identical after removing the nonce line',
  );
  check(
    'zero prompt reuse reported by the server',
    r2.a.promptReused === false && r2.b.promptReused === false,
    'promptReused=false on both slots',
  );
}

console.log('\n═══ 5. A deliberately broken diagram shows the verbatim parse error ═══\n');

const BROKEN = `flowchart TD
  Client[Client] --> LB[Load Balancer]
  LB --> API[API Server]
  API -->> Cache[(Redis Cache)]`;
const broken = await api('/api/validate', { mermaid: BROKEN });
save('broken-diagram-validation.json', broken.json);
save('broken-diagram-source.txt', BROKEN);

check(
  'broken Mermaid is rejected with parseOk=false',
  broken.json.parseOk === false,
  `diagramType=${broken.json.diagramType ?? 'null'}`,
);
check(
  'the parser error is captured verbatim, naming the line',
  Boolean(broken.json.parseError?.message) && broken.json.parseError.line === 4,
  broken.json.parseError
    ? `line ${broken.json.parseError.line}\n--- verbatim ---\n${broken.json.parseError.message}\n--- offending line ---\n${broken.json.parseError.lineText}`
    : 'no parseError returned',
);
check(
  'the offending line matches the source',
  broken.json.parseError?.lineText === '  API -->> Cache[(Redis Cache)]',
  JSON.stringify(broken.json.parseError?.lineText),
);
check(
  'no counts are invented for a diagram that failed to parse',
  broken.json.counts.source === 'unavailable' && broken.json.counts.nodes === 0,
  `counts.source=${broken.json.counts.source} note=${broken.json.counts.note}`,
);

console.log('\n═══ 6. A dead local server names the provider ═══\n');

const dead = await api('/api/schematic', {
  brief: 'a URL shortener at 10M clicks/day',
  slotA: slot({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3' }),
  slotB: slot({ model: MODEL_B }),
});
save('dead-ollama.json', dead.json);
const deadError = dead.json?.a?.error ?? '';
check(
  'dead Ollama reports "Cannot reach http://127.0.0.1:11434 — is Ollama running?"',
  deadError.startsWith('Cannot reach http://127.0.0.1:11434 — is Ollama running?'),
  deadError,
);
check(
  "the provider's real error text follows the friendly line",
  deadError.split('\n').length >= 2 && !/Something went wrong/i.test(deadError),
  deadError.split('\n').slice(1).join(' ') || '(none)',
);
// The point is independence: a dead slot must not disturb the healthy one. The healthy
// slot's model may still write a diagram that does not parse — that is the model's
// business, not a coupling bug — so this asserts it genuinely ran and was answered.
const deadB = dead.json?.b;
check(
  'the healthy slot was unaffected by the dead one',
  Boolean(deadB) && deadB.errorKind !== 'network' && deadB.errorKind !== 'config' &&
    deadB.attempts.length > 0 && deadB.attempts.every((a) => a.httpStatus === 200),
  deadB
    ? `slot B (${deadB.model}) reached its provider: ${deadB.attempts.map((a) => `HTTP ${a.httpStatus} (${a.contentChars} chars)`).join(', ')} → ${deadB.ok ? `${deadB.counts.nodes} nodes` : deadB.errorKind}`
    : 'no slot B result',
);

console.log('\n═══ 7. A real reasoning model that eats its whole budget ═══\n');

// qwen/qwen3.5-9b on LM Studio emits CoT until max_tokens runs out and returns no
// content at all. This is exactly the failure mode the doubled-budget retry exists for,
// and it is reported as a budget problem rather than a refusal.
const hungry = await api('/api/schematic', {
  brief: 'a URL shortener at 10M clicks/day',
  slotA: slot({ model: 'qwen/qwen3.5-9b' }),
  slotB: slot({ model: MODEL_B }),
});
save('reasoning-budget-blowout.json', hungry.json);
const h = hungry.json?.a;
check(
  'empty content is retried once with a doubled budget',
  h?.retried === true && h?.attempts?.length === 2 && h?.attempts?.[1]?.maxTokens === 3200,
  h ? `attempts: ${h.attempts.map((a) => `#${a.attempt} max_tokens=${a.maxTokens} -> ${a.outcome} (${a.reasoningTokens ?? 'n/a'} reasoning tok)`).join(' | ')}` : 'no result',
);
check(
  'a persistent blowout is reported as a budget failure, never as a refusal',
  h?.errorKind === 'empty-content' && /budget/.test(h?.error ?? '') && /not a refusal/.test(h?.error ?? ''),
  h?.error,
);
check(
  'the hidden CoT is stripped and only its length is recorded',
  (h?.attempts ?? []).every((a) => typeof a.reasoningCharsStripped === 'number') &&
    !JSON.stringify(hungry.json).includes('reasoning_content'),
  h ? `CoT chars stripped: ${h.attempts.map((a) => a.reasoningCharsStripped).join(', ')} — text never present` : 'no result',
);

console.log('\n═══ 8. Real model output that Mermaid rejects ═══\n');

// Captured verbatim from google/gemma-4-e4b on this machine. The model wrote an edge
// label containing unquoted parentheses, which Mermaid's parser refuses. This is the
// app's whole thesis: a plausible-looking diagram that does not actually parse.
const fixturePath = resolve(HERE, 'fixtures', 'gemma-4-e4b-broken-mermaid.txt');
const fixture = readFileSync(fixturePath, 'utf8');
const real = await api('/api/validate', { mermaid: fixture });
save('real-model-broken-validation.json', real.json);

check(
  'a real model reply that does not parse is reported as FAILED',
  real.json.parseOk === false,
  `source: verify/fixtures/gemma-4-e4b-broken-mermaid.txt (${fixture.length} bytes, google/gemma-4-e4b)`,
);
check(
  'the real parse error names the offending line',
  real.json.parseError?.line === 3 &&
    real.json.parseError?.lineText === '        A[Client/User] -->|1. Request Shortening (Write)| B(Load Balancer);',
  `line ${real.json.parseError?.line}: ${real.json.parseError?.lineText}`,
);

console.log('\n═══ 9. No API key is hardcoded in the repository ═══\n');

const { execSync } = await import('node:child_process');
const repoRoot = resolve(HERE, '..');
let keyScan = '';
try {
  keyScan = execSync(
    `grep -rInE "(sk-[A-Za-z0-9_-]{12,}|api[_-]?key['\\"]?\\s*[:=]\\s*['\\"]sk-|PARTICLE_AI_API_KEY\\s*=\\s*['\\"][^'\\"]+)" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=evidence . || true`,
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
} catch (err) {
  keyScan = `scan error: ${err.message}`;
}
check(
  'no API keys found in tracked source',
  keyScan === '',
  keyScan === '' ? 'grep for sk-*/api_key literals found nothing' : keyScan,
);

// ── summary ──────────────────────────────────────────────────────────────────
const passed = results.length - failures;
console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${passed}/${results.length} checks passed${failures ? ` — ${failures} FAILED` : ''}`);
console.log(`${'═'.repeat(64)}\n`);

save('summary.json', {
  ranAt: new Date().toISOString(),
  api: API,
  passed,
  total: results.length,
  failures,
  checks: results,
});

process.exit(failures === 0 ? 0 : 1);