import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isLocalConcurrencyRefusal, runSchematic } from '../src/run.js';
import type { ModelResult, SlotConfig } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 11435;
const MOCK = `http://127.0.0.1:${PORT}/v1`;

let child: ChildProcess | null = null;

async function mock(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const setMode = (mode: string) => mock('/__mock/config', { mode });
/** POST /__mock/reset clears the recorded request log. Body is required to force POST. */
const reset = () => mock('/__mock/reset', {});
const requests = () => mock('/__mock/requests').then((r) => r.requests as Array<Record<string, any>>);

before(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', resolve(HERE, 'mock-particle.ts'), String(PORT)], {
    cwd: resolve(HERE, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${MOCK}/models`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('mock particle server did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  child?.kill('SIGTERM');
});

function slot(over: Partial<SlotConfig> = {}): SlotConfig {
  return {
    provider: 'particle',
    baseUrl: MOCK,
    apiKey: 'test-key-not-a-real-secret',
    model: 'deepseek-v4.1-flash',
    temperature: 0,
    maxTokens: 1600,
    disableReasoning: false,
    ...over,
  };
}

const brief = 'a URL shortener at 10M clicks/day';
const run = (a: Partial<SlotConfig>, b: Partial<SlotConfig>, briefText = brief) =>
  runSchematic({
    brief: briefText,
    slotA: slot({ model: 'deepseek-v4-flash-0731', ...a }),
    slotB: slot({ model: 'deepseek-v4.1-flash', ...b }),
  });

test('both slots produce rendered diagrams from real Mermaid source', async () => {
  await setMode('reasoning');
  await reset();
  const r = await run({}, {});

  for (const m of [r.a, r.b] as ModelResult[]) {
    assert.equal(m.ok, true, `${m.slot}: ${m.error}`);
    assert.equal(m.parseOk, true, `${m.slot} parse: ${m.parseError?.message}`);
    assert.equal(m.errorKind, 'none');
    assert.equal(m.extractionPath, 'mermaid-fence');
    assert.ok(m.mermaid && m.mermaid.startsWith('flowchart'));
    assert.equal(m.counts.source, 'parsed');
    assert.ok(m.counts.nodes > 0 && m.counts.edges > 0);
    assert.equal(m.byteCount, Buffer.byteLength(m.mermaid!, 'utf8'));
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(r.a.counts.nodes, 7);
  assert.equal(r.b.counts.nodes, 13);
});

test('reasoning tokens are read from usage when the provider reports them', async () => {
  await setMode('reasoning');
  const r = await run({}, {});
  for (const m of [r.a, r.b]) {
    assert.equal(m.reasoningSupported, true);
    assert.equal(typeof m.reasoningTokens, 'number');
    assert.equal(m.reasoningTokens, 412);
    assert.equal(typeof m.promptTokens, 'number');
    assert.equal(typeof m.completionTokens, 'number');
  }
});

test('reasoning_content is stripped and never appears anywhere in the result', async () => {
  await setMode('reasoning');
  const r = await run({}, {});
  const serialised = JSON.stringify(r);
  assert.ok(!serialised.includes('Let me think about the architecture'), 'CoT leaked into the response');
  assert.ok(!serialised.includes('reasoning_content'), 'reasoning_content key leaked');
  for (const m of [r.a, r.b]) {
    assert.ok(!m.rawReply.includes('Let me think'), 'CoT leaked into rawReply');
    assert.ok(m.rawReply.includes('flowchart'), 'real content must survive');
    // Only the length may be recorded, and only as a diagnostic.
    const stripped = m.attempts.reduce((n, a) => n + a.reasoningCharsStripped, 0);
    assert.ok(stripped > 0, 'expected the CoT to be counted and dropped');
  }
});

test('reasoning tokens are null (rendered as n/a) when the provider omits them', async () => {
  await setMode('no-reasoning');
  const r = await run({}, {});
  for (const m of [r.a, r.b]) {
    assert.equal(m.reasoningSupported, false);
    assert.equal(m.reasoningTokens, null, 'must be null, never 0, never invented');
    assert.equal(m.ok, true);
  }
});

test('HTTP 200 with empty content retries once with a doubled budget', async () => {
  await setMode('empty-first');
  const r = await run({ maxTokens: 900 }, { maxTokens: 900 });
  for (const m of [r.a, r.b]) {
    assert.equal(m.retried, true, `${m.slot} should have retried`);
    assert.equal(m.attempts.length, 2);
    assert.equal(m.attempts[0].outcome, 'empty-content');
    assert.equal(m.attempts[0].maxTokens, 900);
    assert.equal(m.attempts[1].maxTokens, 1800, 'budget must double');
    assert.equal(m.ok, true, 'the retry should have succeeded');
    assert.ok(m.notes.some((n) => /empty content/.test(n)));
  }
});

test('the doubled budget is capped at 4000', async () => {
  await setMode('empty-first');
  const r = await run({ maxTokens: 4000 }, { maxTokens: 4000 });
  for (const m of [r.a, r.b]) {
    assert.equal(m.attempts[1].maxTokens, 4000, 'must not exceed the ceiling');
  }
});

test('persistent empty content is reported as a budget failure, never as a refusal', async () => {
  await setMode('empty-always');
  const r = await run({}, {});
  for (const m of [r.a, r.b]) {
    assert.equal(m.ok, false);
    assert.equal(m.errorKind, 'empty-content');
    assert.match(m.error ?? '', /empty content/);
    assert.match(m.error ?? '', /budget/);
    assert.match(m.error ?? '', /not a refusal/);
    assert.equal(m.attempts.length, 2);
  }
});

test('provider HTTP errors are surfaced verbatim', async () => {
  await setMode('http-500');
  const r = await run({}, {});
  for (const m of [r.a, r.b]) {
    assert.equal(m.ok, false);
    assert.equal(m.errorKind, 'http');
    assert.match(m.error ?? '', /HTTP 500/);
    assert.match(m.error ?? '', /upstream model unavailable: capacity exhausted/);
    assert.match(m.error ?? '', /\/chat\/completions/);
  }
});

test('a dead local server names the provider and shows the real error', async () => {
  const r = await runSchematic({
    brief,
    slotA: slot({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3' }),
    slotB: slot({}),
  });
  assert.equal(r.a.ok, false);
  assert.equal(r.a.errorKind, 'network');
  assert.match(r.a.error ?? '', /^Cannot reach http:\/\/127\.0\.0\.1:11434 — is Ollama running\?/);
  // The provider's real error text follows the friendly line.
  assert.ok((r.a.error ?? '').split('\n').length >= 2);
  assert.ok(!/Something went wrong/i.test(r.a.error ?? ''));
});

test('a dead LM Studio server says so by name', async () => {
  const r = await runSchematic({
    brief,
    slotA: slot({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:12399/v1', apiKey: '', model: 'x' }),
    slotB: slot({}),
  });
  assert.match(r.a.error ?? '', /^Cannot reach http:\/\/127\.0\.0\.1:12399 — is LM Studio running\?/);
});

test('chat_template_kwargs is sent only for Particle.ai + deepseek-* + disableReasoning', async () => {
  await setMode('reasoning');

  await reset();
  await run({ disableReasoning: true }, { disableReasoning: true });
  let seen = await requests();
  assert.equal(seen.length, 2);
  for (const req of seen) {
    assert.deepEqual(req.chat_template_kwargs, { enable_thinking: false }, 'expected the flag on deepseek-*');
  }

  // Same provider, a non-deepseek model: the flag must be omitted entirely.
  await reset();
  await run({ model: 'glm5.3flash', disableReasoning: true }, { model: 'glm5.3flash', disableReasoning: true });
  seen = await requests();
  for (const req of seen) {
    assert.equal('chat_template_kwargs' in req, false, 'glm must not receive the flag');
  }

  // A different provider: the flag must be omitted entirely.
  await reset();
  await runSchematic({
    brief,
    slotA: slot({ provider: 'lmstudio', baseUrl: MOCK, apiKey: '', model: 'deepseek-v4.1-flash', disableReasoning: true }),
    slotB: slot({ provider: 'custom', baseUrl: MOCK, apiKey: '', model: 'deepseek-v4.1-flash', disableReasoning: true }),
  });
  seen = await requests();
  for (const req of seen) {
    assert.equal('chat_template_kwargs' in req, false, 'non-Particle providers must not receive the flag');
  }
});

test('disabling thinking on Particle actually removes reasoning tokens from usage', async () => {
  await setMode('reasoning');
  const r = await run({ disableReasoning: true }, { disableReasoning: true });
  for (const m of [r.a, r.b]) {
    assert.equal(m.reasoningSupported, false);
    assert.equal(m.reasoningTokens, null);
  }
});

test('a model missing from /v1/models still runs — nothing is gated on the model list', async () => {
  await setMode('reasoning');
  const listed = await mock('/__mock/requests');
  assert.ok(Array.isArray(listed.requests));
  const r = await run({ model: 'a-model-not-in-any-list' }, {});
  assert.equal(r.a.ok, true, `hand-typed model should still run: ${r.a.error}`);
  assert.equal(r.a.model, 'a-model-not-in-any-list');
});

test('a missing API key fails fast with a legible message', async () => {
  const r = await runSchematic({
    brief,
    slotA: slot({ apiKey: '' }),
    slotB: slot({}),
  });
  assert.equal(r.a.ok, false);
  assert.equal(r.a.errorKind, 'config');
  assert.match(r.a.error ?? '', /Particle\.ai requires an API key/);
  assert.equal(r.a.attempts.length, 0, 'no request should have been sent');
});

test('the checklist diff is the viral payload: B has retries and observability, A does not', async () => {
  await setMode('reasoning');
  const r = await run({}, {});

  const a = Object.fromEntries(r.a.checklist.map((i) => [i.concept, i]));
  const b = Object.fromEntries(r.b.checklist.map((i) => [i.concept, i]));

  assert.equal(a.Retry.present, false, 'A should be missing retries');
  assert.equal(b.Retry.present, true, 'B should have retries');
  assert.equal(a['Observability / metrics'].present, false, 'A should be missing observability');
  assert.equal(b['Observability / metrics'].present, true, 'B should have observability');

  assert.equal(b.Retry.matchedLabel, 'retry with exponential backoff');
  assert.equal(b.Retry.matchedIn, 'edge');
  assert.equal(b['Observability / metrics'].matchedLabel, 'Prometheus Metrics');

  // Both share these, so they are not the story.
  for (const shared of ['Cache', 'Load balancer', 'Database']) {
    assert.equal(a[shared].present, true, `A should have ${shared}`);
    assert.equal(b[shared].present, true, `B should have ${shared}`);
  }

  assert.match(r.diff.headline, /^B planned for .*; A did not\.$/);
  assert.match(r.diff.headline, /retries/);
  assert.match(r.diff.headline, /observability/);
  assert.ok(r.diff.onlyInB.length > 0);
});

test('every tick in the pipeline result is backed by a label present in that diagram source', async () => {
  await setMode('reasoning');
  const r = await run({}, {});
  for (const m of [r.a, r.b]) {
    for (const item of m.checklist.filter((i) => i.present)) {
      assert.ok(item.matchedLabel, `${m.slot} ${item.concept} ticked without a label`);
      assert.ok(
        m.mermaid!.includes(item.matchedLabel!),
        `${m.slot} ${item.concept}: label ${JSON.stringify(item.matchedLabel)} is not in the diagram source`,
      );
      assert.ok(
        item.matchedIn === 'node' || item.matchedIn === 'edge',
        `expected a parsed label, got matchedIn=${item.matchedIn}`,
      );
    }
  }
});

test('no two runs ever send the same prompt, and reuse is reported', async () => {
  await setMode('reasoning');
  const r1 = await run({}, {});
  const r2 = await run({}, {});

  assert.notEqual(r1.nonce, r2.nonce);
  assert.notEqual(r1.promptSent, r2.promptSent);
  assert.notEqual(r1.a.promptSha256, r2.a.promptSha256);
  assert.equal(r1.a.promptReused, false);
  assert.equal(r2.a.promptReused, false);
  assert.deepEqual(r1.warnings, []);

  // The prompt differs only by the nonce, so the comparison stays fair.
  const strip = (s: string) => s.replace(/\(request nonce: [0-9a-f]+ — ignore this line\)/, '');
  assert.equal(strip(r1.promptSent), strip(r2.promptSent));

  // Both slots received the byte-identical prompt.
  assert.equal(r1.a.promptSha256, r1.b.promptSha256);
});

test('the prompt sent is the exact brief both slots receive', async () => {
  await setMode('reasoning');
  await reset();
  const r = await run({}, {});
  assert.match(r.promptSent, /^Design the architecture for a URL shortener at 10M clicks\/day\./);
  assert.match(r.promptSent, /Output ONE Mermaid flowchart\./);
  assert.match(r.promptSent, /Output only the Mermaid source in a ```mermaid fence\./);
  assert.match(r.promptSent, /Label every component and every edge\./);

  const seen = await requests();
  for (const req of seen) {
    const user = req.messages.find((m: any) => m.role === 'user');
    const system = req.messages.find((m: any) => m.role === 'system');
    assert.equal(user.content, r.promptSent, 'the user brief must be byte-identical across slots');
    assert.equal(system.content, "You are a precise assistant. Answer the user's request directly.");
    assert.equal(req.temperature, 0);
    assert.equal(req.max_tokens, 1600, 'default budget');
    assert.equal(req.stream, false);
  }
});

test('a model that answers with no diagram is reported, not scored', async () => {
  // Point at the mock's /models route via a bogus chat path to get a clean 404.
  const r = await runSchematic({
    brief,
    slotA: slot({ baseUrl: `http://127.0.0.1:${PORT}/nope` }),
    slotB: slot({}),
  });
  assert.equal(r.a.ok, false);
  assert.equal(r.a.errorKind, 'http');
  assert.match(r.a.error ?? '', /HTTP 404/);
  assert.match(r.a.error ?? '', /no route for/);
});
test('a serial-only local server is detected and the refused slot is re-run alone', async () => {
  // LM Studio serves one request at a time and answers a second simultaneous one with
  // an instant HTTP 500. Both slots must still come back with a diagram.
  await setMode('serial-only');
  const r = await run({}, {});

  for (const m of [r.a, r.b] as ModelResult[]) {
    assert.equal(m.ok, true, `${m.slot} should have recovered: ${m.error}`);
    assert.equal(m.parseOk, true);
  }
  const recovered = [r.a, r.b].filter((m) => m.sequentialRetry);
  assert.equal(recovered.length, 1, 'exactly one slot should have been re-run sequentially');
  assert.match(recovered[0].notes[0] ?? '', /refused the concurrent request/);
  assert.match(recovered[0].notes[0] ?? '', /one request at a time/);
  assert.ok(
    r.warnings.some((w) => /re-ran it sequentially and it succeeded/.test(w)),
    `warnings should record the recovery: ${JSON.stringify(r.warnings)}`,
  );
});

test('the concurrency-refusal classifier fires for local servers only', () => {
  const httpError = (provider: SlotConfig['provider'], baseUrl: string, status: number): ModelResult => ({
    ...({} as ModelResult),
    provider,
    baseUrl,
    errorKind: 'http',
    attempts: [{ attempt: 1, maxTokens: 1600, httpStatus: status, latencyMs: 3,
      contentChars: 0, reasoningCharsStripped: 0, reasoningTokens: null,
      outcome: 'http-error', error: `HTTP ${status}` }],
  });

  // Local servers: a 5xx/4xx on a concurrent request is the serialisation signal.
  assert.equal(isLocalConcurrencyRefusal(httpError('lmstudio', 'http://127.0.0.1:1234/v1', 500)), true);
  assert.equal(isLocalConcurrencyRefusal(httpError('ollama', 'http://127.0.0.1:11434/v1', 400)), true);
  assert.equal(isLocalConcurrencyRefusal(httpError('custom', 'http://192.168.1.50:8000/v1', 500)), true);
  assert.equal(isLocalConcurrencyRefusal(httpError('custom', 'http://localhost:8080/v1', 503)), true);

  // Hosted providers: never. A 5xx there is a real upstream failure and is reported.
  assert.equal(isLocalConcurrencyRefusal(httpError('particle', 'https://api.particle.ai/v1', 500)), false);
  assert.equal(isLocalConcurrencyRefusal(httpError('openrouter', 'https://openrouter.ai/api/v1', 502)), false);
  assert.equal(isLocalConcurrencyRefusal(httpError('custom', 'https://api.example.com/v1', 500)), false);

  // Only HTTP errors qualify — a parse failure or a dead socket is a different problem.
  assert.equal(isLocalConcurrencyRefusal({ ...httpError('lmstudio', 'http://127.0.0.1:1234/v1', 500), errorKind: 'network' }), false);
  assert.equal(isLocalConcurrencyRefusal({ ...httpError('lmstudio', 'http://127.0.0.1:1234/v1', 500), errorKind: 'empty-content' }), false);
});

test('an unreachable non-local provider is never given a sequential retry', async () => {
  await setMode('http-500');
  const r = await runSchematic({
    brief,
    // Reserved TLD: guaranteed DNS failure, and definitely not local. Both slots are
    // non-local so nothing in this run can legitimately enter the local recovery path.
    slotA: slot({ provider: 'custom', baseUrl: 'https://api.example.invalid/v1', apiKey: '' }),
    slotB: slot({ provider: 'custom', baseUrl: 'https://api.example.invalid/v1', apiKey: '' }),
  });
  assert.equal(r.a.sequentialRetry, false);
  assert.equal(r.a.ok, false);
  assert.ok((r.a.error ?? '').length > 0, 'a real error must be reported');
  assert.ok(
    !r.warnings.some((w) => /re-ran it sequentially/.test(w)),
    'the local-only recovery path must not fire',
  );
});

test('a local server that is genuinely broken is still reported verbatim', async () => {
  // The sequential re-run happens, fails the same way, and the real error survives.
  await setMode('http-500');
  const r = await runSchematic({
    brief,
    slotA: slot({ provider: 'lmstudio', baseUrl: MOCK, apiKey: '' }),
    slotB: slot({}),
  });
  assert.equal(r.a.ok, false);
  assert.match(r.a.error ?? '', /capacity exhausted/);
});

test('a reply cut off by the token ceiling is flagged as truncated', async () => {
  await setMode('truncated');
  const r = await run({}, {});
  for (const m of [r.a, r.b] as ModelResult[]) {
    assert.equal(m.finishReason, 'length');
    assert.equal(m.truncated, true);
    assert.ok(
      m.notes.some((n) => /max_tokens ceiling/.test(n)),
      `expected a truncation note, got ${JSON.stringify(m.notes)}`,
    );
    assert.ok(r.warnings.some((w) => /max_tokens ceiling/.test(w)));
  }
});

test('a diagram that parses but has no edges is flagged as degenerate', async () => {
  await setMode('truncated');
  const r = await run({}, {});
  for (const m of [r.a, r.b] as ModelResult[]) {
    // It genuinely parses — that is the trap.
    assert.equal(m.parseOk, true);
    assert.equal(m.counts.source, 'parsed');
    assert.equal(m.counts.nodes, 4);
    assert.equal(m.counts.edges, 0);
    // And the app says so instead of quietly scoring it.
    assert.equal(m.degenerate, true);
    assert.ok(m.notes.some((n) => /no edges at all/.test(n)));
    assert.ok(r.warnings.some((w) => /contains no edges/.test(w)));
  }
});

test('a healthy diagram is neither truncated nor degenerate', async () => {
  await setMode('reasoning');
  const r = await run({}, {});
  for (const m of [r.a, r.b] as ModelResult[]) {
    assert.equal(m.truncated, false);
    assert.equal(m.degenerate, false);
    assert.equal(m.finishReason, 'stop');
    assert.ok(m.counts.edges > 0);
  }
});

test('a slot with no Mermaid source reports no hash rather than the empty-string hash', async () => {
  await setMode('no-diagram');
  const r = await run({}, {});
  for (const m of [r.a, r.b] as ModelResult[]) {
    assert.equal(m.errorKind, 'no-mermaid');
    assert.equal(m.sha256, null, 'must not be sha256("")');
    // The reply itself is still identifiable, so nothing is lost.
    assert.match(m.rawReplySha256 ?? '', /^[0-9a-f]{64}$/);
  }
});
