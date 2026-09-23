/**
 * Mock OpenAI-compatible server that emulates Particle.ai's response shape.
 *
 * This exists so the reasoning-token rules can be tested for real without an API key:
 * Particle reports `usage.completion_tokens_details.reasoning_tokens` and can return
 * chain-of-thought in `message.reasoning_content`. The mock can also be told to return
 * HTTP 200 with empty content, which is what a hidden-CoT budget blowout looks like.
 *
 * Run:  node --import tsx server/test/mock-particle.ts [port]
 * Control:
 *   POST /__mock/config   { mode, model? }
 *   GET  /__mock/requests -> every request body received, for assertions
 */
import { createServer } from 'node:http';

type Mode = 'reasoning' | 'no-reasoning' | 'empty-first' | 'empty-always' | 'http-500' | 'serial-only' | 'truncated' | 'no-diagram';

interface MockConfig {
  mode: Mode;
  /** Model name reported back in the body. */
  model: string;
}

const state: MockConfig = { mode: 'reasoning', model: 'deepseek-v4.1-flash' };
const received: Array<Record<string, unknown>> = [];
const perModelCalls = new Map<string, number>();
let callCount = 0;

/**
 * The fixture is the viral payload itself: the older model (…-0731) produces a
 * plausible diagram with no retries and no observability; the newer one has both.
 * Chosen by model name so the mapping is deterministic, not order-dependent.
 */
function diagramFor(model: string): string {
  return /0731/.test(model) ? DIAGRAM_A : DIAGRAM_B;
}

const DIAGRAM_A = `flowchart TD
  Client[Client] --> DNS[DNS]
  DNS --> LB[Load Balancer]
  LB --> API[API Server]
  API --> Cache[(Redis Cache)]
  API --> DB[(Postgres Database)]
  API --> Short[Shortener Service]
  Short --> DB`;

const DIAGRAM_B = `flowchart TD
  Client[Client] --> CDN[CDN Edge]
  CDN --> LB[Load Balancer]
  LB --> API[API Server]
  API --> Auth[Auth Service]
  API --> RateLimit[Rate Limiter]
  API --> Cache[(Redis Cache)]
  API --> Queue[[Kafka Queue]]
  Queue --> Worker[Worker Pool]
  Worker --> DB[(Postgres Database)]
  Worker -.-> DLQ[Dead Letter Queue]
  Worker -. retry with exponential backoff .-> Queue
  API --> Metrics[Prometheus Metrics]
  API -. traces .-> Trace[OpenTelemetry Collector]`;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function completion(content: string, opts: { reasoning: boolean; reasoningTokens: number; finishReason?: string }) {
  const message: Record<string, unknown> = { role: 'assistant', content };
  const usage: Record<string, unknown> = {
    prompt_tokens: 118,
    completion_tokens: opts.reasoning ? 640 : 420,
    total_tokens: opts.reasoning ? 758 : 538,
  };
  if (opts.reasoning) {
    // Chain-of-thought that must never surface in the app.
    message.reasoning_content =
      'Let me think about the architecture step by step. First I should consider the write path...';
    usage.completion_tokens_details = { reasoning_tokens: opts.reasoningTokens };
  }
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, message, finish_reason: opts.finishReason ?? 'stop' }],
    usage,
  };
}

/** The actual completion behaviour, wrapped by the in-flight guard above. */
async function handleCompletion(
  res: import('node:http').ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const model = String(body.model ?? state.model);
  const modelCalls = (perModelCalls.get(model) ?? 0) + 1;
  perModelCalls.set(model, modelCalls);

  const thinkingDisabled =
    (body.chat_template_kwargs as { enable_thinking?: boolean } | undefined)?.enable_thinking === false;
  // A real reasoning model stops emitting reasoning_tokens once thinking is disabled.
  const reasoning = !thinkingDisabled && state.mode !== 'no-reasoning';
  const diagram = diagramFor(model);

  if (state.mode === 'http-500') {
    json(res, 500, { error: { message: 'upstream model unavailable: capacity exhausted', type: 'server_error' } });
    return;
  }

  if (state.mode === 'truncated') {
    // Nodes declared, edges never written: the token ceiling cut the answer off. This
    // parses cleanly in Mermaid, which is exactly what makes it dangerous.
    const partial = '```mermaid\nflowchart TD\n  Client[Client]\n  LB[Load Balancer]\n  API[API Server]\n  DB[(Postgres Database)]\n```';
    json(res, 200, completion(partial, { reasoning, reasoningTokens: 900, finishReason: 'length' }));
    return;
  }

  if (state.mode === 'no-diagram') {
    // A perfectly good prose answer with no Mermaid in it at all.
    json(res, 200, completion(
      'Sure! A URL shortener needs a load balancer, an application tier, and a key-value store.\n' +
      'I would start with a managed Postgres and a Redis cache in front of it.',
      { reasoning, reasoningTokens: 210 },
    ));
    return;
  }

  if (state.mode === 'empty-always' || (state.mode === 'empty-first' && modelCalls === 1)) {
    // HTTP 200, no content — the hidden CoT ate the whole budget.
    json(res, 200, completion('', { reasoning: true, reasoningTokens: 1580 }));
    return;
  }

  // A little latency so concurrent requests actually overlap.
  await new Promise((r) => setTimeout(r, 40));
  json(res, 200, completion('```mermaid\n' + diagram + '\n```', {
    reasoning,
    reasoningTokens: 412,
  }));
}

let inFlight = 0;

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    json(res, 200, {
      object: 'list',
      data: [
        { id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'particle' },
        { id: 'deepseek-v4-flash-0731', object: 'model', owned_by: 'particle' },
        { id: 'glm5.3flash', object: 'model', owned_by: 'particle' },
      ],
    });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/__mock/config')) {
    const body = JSON.parse((await readBody(req)) || '{}') as Partial<MockConfig>;
    if (body.mode) state.mode = body.mode;
    if (body.model) state.model = body.model;
    callCount = 0;
    perModelCalls.clear();
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === 'GET' && url.startsWith('/__mock/requests')) {
    json(res, 200, { requests: received, callCount });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/__mock/reset')) {
    received.length = 0;
    callCount = 0;
    perModelCalls.clear();
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
    received.push(body);
    callCount += 1;

    // Emulates LM Studio: one request at a time, and a second simultaneous one gets an
    // instant HTTP 500 without the body being looked at.
    if (state.mode === 'serial-only' && inFlight > 0) {
      json(res, 500, { error: { message: 'Internal Server Error' } });
      return;
    }
    inFlight += 1;
    try {
      await handleCompletion(res, body);
    } finally {
      inFlight -= 1;
    }
    return;
  }

  json(res, 404, { error: { message: `mock: no route for ${req.method} ${url}` } });
});

const port = Number.parseInt(process.argv[2] ?? '11435', 10);
server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-particle] listening on http://127.0.0.1:${port}/v1`);
});