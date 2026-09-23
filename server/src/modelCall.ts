import { isLocalProvider, normalizeBaseUrl, shouldSendThinkingFlag } from './providers.js';
import type { AttemptRecord, ProviderId, SlotConfig, SlotId } from './types.js';

export const SYSTEM_PROMPT = "You are a precise assistant. Answer the user's request directly.";

export const DEFAULT_MAX_TOKENS = 1600;
/** Reasoning models can burn the whole budget on hidden CoT; the retry doubles up to here. */
export const MAX_TOKENS_CEILING = 4000;

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SCHEMATIC_TIMEOUT_MS ?? '240000', 10);

/**
 * The exact brief both slots receive. The only variable part is the nonce.
 *
 * The nonce exists so that no two runs ever send byte-identical prompts. A response
 * cache keyed on the prompt would otherwise silently fake determinism, which would
 * make every "model A vs model B" comparison worthless.
 */
export function buildUserPrompt(brief: string, nonce: string): string {
  return [
    `Design the architecture for ${brief}.`,
    '',
    'Output ONE Mermaid flowchart. Output only the Mermaid source in a ```mermaid fence. Label every component and every edge.',
    '',
    `(request nonce: ${nonce} — ignore this line)`,
  ].join('\n');
}

export interface CallInput {
  slot: SlotId;
  config: SlotConfig;
  /** Pre-built, byte-identical across slots for a given run. */
  prompt: string;
}

export interface CallOutcome {
  ok: boolean;
  content: string;
  error: string | null;
  errorKind: 'none' | 'network' | 'http' | 'empty-content';
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** null => the provider reported no reasoning breakdown. The UI prints "n/a". */
  reasoningTokens: number | null;
  reasoningSupported: boolean;
  attempts: AttemptRecord[];
  finishReason: string | null;
  retried: boolean;
  notes: string[];
}

interface UsageReading {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  reasoningSupported: boolean;
}

/**
 * The provider's stop reason. 'length' is the one that matters: it means the answer was
 * cut off by max_tokens, which is how a diagram ends up half-written.
 */
function readFinishReason(json: unknown): string | null {
  const reason = (json as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]?.finish_reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Reasoning tokens are read, never assumed.
 *
 * `completion_tokens_details.reasoning_tokens` simply does not exist on most local
 * servers. When it is missing we return null so the UI renders "n/a" and hides the
 * thinking toggle. We never coerce that absence to 0, and we never estimate it.
 */
function readUsage(json: unknown): UsageReading {
  const usage = (json as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: null, completionTokens: null, reasoningTokens: null, reasoningSupported: false };
  }
  const details = (usage as { completion_tokens_details?: Record<string, unknown> })
    .completion_tokens_details;
  const reasoningTokens = num(details?.reasoning_tokens);
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    reasoningTokens,
    reasoningSupported: reasoningTokens !== null,
  };
}

/**
 * Pull the assistant text out of a chat-completions body.
 *
 * `reasoning_content` (and the equivalent `reasoning`) is chain-of-thought. It is
 * deliberately never read into any returned field: only its character length is
 * recorded, as a diagnostic. The CoT text itself is never logged, returned, stored,
 * or displayed anywhere in this app.
 */
function readMessage(json: unknown): { content: string; reasoningCharsStripped: number } {
  const message = (json as { choices?: Array<{ message?: Record<string, unknown> }> })
    ?.choices?.[0]?.message;
  if (!message) return { content: '', reasoningCharsStripped: 0 };

  const content = typeof message.content === 'string' ? message.content : '';
  const cot = message.reasoning_content ?? message.reasoning;
  const reasoningCharsStripped = typeof cot === 'string' ? cot.length : 0;
  return { content, reasoningCharsStripped };
}

/** Provider error bodies are quoted verbatim; a wrong key should look like a wrong key. */
function extractProviderError(status: number, bodyText: string, url: string): string {
  let detail = bodyText.trim();
  let note = '';

  if (detail.startsWith('<')) {
    // Some local servers return an HTML error page. Keep its real text, but say what it
    // is so the reader is not staring at a wall of markup.
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(detail)?.[1]?.trim();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(detail)?.[1]?.trim();
    const summary = [title, pre].filter(Boolean).join(': ');
    note = '\n(provider returned an HTML error page, not JSON)';
    detail = summary || detail.slice(0, 400);
  } else {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const err = parsed.error;
      if (typeof err === 'string') detail = err;
      else if (err && typeof err === 'object') {
        const e = err as Record<string, unknown>;
        detail = [e.message, e.code, e.type].filter((x) => typeof x === 'string').join(' — ') || detail;
      } else if (typeof parsed.message === 'string') {
        detail = parsed.message;
      }
    } catch {
      /* non-JSON, non-HTML error body: keep the raw text */
    }
  }

  if (detail.length > 1200) detail = `${detail.slice(0, 1200)}…`;
  return `HTTP ${status} from ${url}\n${detail || '(empty error body)'}${note}`;
}

/**
 * Name the server the way a human would recognise it.
 *
 * The API base URL carries a `/v1` path segment, but nobody thinks of their local
 * server as "http://127.0.0.1:11434/v1". The friendly hint points at the origin, and the
 * full request URL still appears in the verbatim error text underneath.
 */
function serverRoot(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

function networkError(provider: ProviderId, baseUrl: string, real: string): string {
  const root = serverRoot(baseUrl);
  if (provider === 'ollama') return `Cannot reach ${root} — is Ollama running?\n${real}`;
  if (provider === 'lmstudio') return `Cannot reach ${root} — is LM Studio running?\n${real}`;
  return `Cannot reach ${root}.\n${real}`;
}

function buildBody(config: SlotConfig, prompt: string, maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: config.temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // Only Particle.ai + a deepseek-* model understands this field. Every other provider
  // either ignores unknown fields or rejects them, so we omit it entirely.
  if (shouldSendThinkingFlag(config.provider, config.model, config.disableReasoning)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  return body;
}

async function postOnce(
  config: SlotConfig,
  url: string,
  prompt: string,
  maxTokens: number,
): Promise<{ status: number | null; json: unknown; bodyText: string; latencyMs: number; networkFailure: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(config, prompt, maxTokens)),
      signal: controller.signal,
    });

    const bodyText = await res.text();
    const latencyMs = Date.now() - started;
    let json: unknown = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      /* leave json null; the caller falls back to bodyText */
    }
    return { status: res.status, json, bodyText, latencyMs, networkFailure: null };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const real =
      err instanceof Error && err.name === 'AbortError'
        ? `Request timed out after ${REQUEST_TIMEOUT_MS} ms.`
        : message;
    return { status: null, json: null, bodyText: '', latencyMs, networkFailure: real };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One model call, with the empty-content retry.
 *
 * HTTP 200 with empty content is NOT a refusal — it is almost always a reasoning model
 * spending its entire max_tokens budget on hidden chain-of-thought. We retry exactly
 * once with a doubled budget, capped at MAX_TOKENS_CEILING, before reporting failure.
 */
export async function callModel(input: CallInput): Promise<CallOutcome> {
  const { config } = input;
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = `${baseUrl}/chat/completions`;

  const attempts: AttemptRecord[] = [];
  const notes: string[] = [];
  let maxTokens = Math.max(1, Math.round(config.maxTokens || DEFAULT_MAX_TOKENS));
  let retried = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await postOnce(config, url, input.prompt, maxTokens);

    if (res.networkFailure) {
      attempts.push({
        attempt, maxTokens, httpStatus: null, latencyMs: res.latencyMs,
        contentChars: 0, reasoningCharsStripped: 0, reasoningTokens: null,
        finishReason: null, outcome: 'network-error', error: res.networkFailure,
      });
      return {
        ok: false, content: '', errorKind: 'network',
        error: networkError(config.provider, baseUrl, res.networkFailure),
        latencyMs: res.latencyMs, promptTokens: null, completionTokens: null,
        reasoningTokens: null, reasoningSupported: false,
        attempts, finishReason: null, retried, notes,
      };
    }

    if (res.status === null || res.status < 200 || res.status >= 300) {
      const error = extractProviderError(res.status ?? 0, res.bodyText, url);
      attempts.push({
        attempt, maxTokens, httpStatus: res.status, latencyMs: res.latencyMs,
        contentChars: 0, reasoningCharsStripped: 0, reasoningTokens: null,
        finishReason: null, outcome: 'http-error', error,
      });
      return {
        ok: false, content: '', errorKind: 'http', error, latencyMs: res.latencyMs,
        promptTokens: null, completionTokens: null, reasoningTokens: null,
        reasoningSupported: false, attempts, finishReason: null, retried, notes,
      };
    }

    const usage = readUsage(res.json);
    const { content, reasoningCharsStripped } = readMessage(res.json);
    const hasContent = content.trim().length > 0;

    const finishReason = readFinishReason(res.json);
    attempts.push({
      attempt, maxTokens, httpStatus: res.status, latencyMs: res.latencyMs,
      contentChars: content.length, reasoningCharsStripped,
      reasoningTokens: usage.reasoningTokens,
      finishReason,
      outcome: hasContent ? 'ok' : 'empty-content',
      error: hasContent ? null : 'HTTP 200 with empty content',
    });

    if (hasContent) {
      if (finishReason === 'length') {
        notes.push(
          `The provider stopped at the max_tokens ceiling (finish_reason=length), so the reply may be cut off mid-diagram. Raise Max Tokens for this slot.`,
        );
      }
      return {
        ok: true, content, error: null, errorKind: 'none',
        latencyMs: res.latencyMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        reasoningSupported: usage.reasoningSupported,
        attempts, finishReason, retried, notes,
      };
    }

    // Empty content. Retry once with a doubled budget.
    if (attempt === 1) {
      const doubled = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
      notes.push(
        `HTTP 200 with empty content — hidden reasoning likely consumed the ${maxTokens}-token budget; retrying with max_tokens=${doubled}.`,
      );
      if (reasoningCharsStripped > 0) {
        notes.push(`Response carried ${reasoningCharsStripped} chars of chain-of-thought, stripped and not stored.`);
      }
      if (usage.reasoningTokens !== null) {
        notes.push(`Provider reported ${usage.reasoningTokens} reasoning tokens on the empty attempt.`);
      }
      maxTokens = doubled;
      retried = true;
      continue;
    }

    const cot = reasoningCharsStripped > 0 ? ` (${reasoningCharsStripped} chars of hidden CoT were stripped)` : '';
    const rt = usage.reasoningTokens !== null ? `, ${usage.reasoningTokens} reasoning tokens` : '';
    const error =
      `HTTP 200 with empty content on both attempts${cot}. ` +
      `Last budget: max_tokens=${maxTokens}${rt}. ` +
      'This is a budget/behaviour failure, not a refusal.';
    return {
      ok: false, content: '', errorKind: 'empty-content', error,
      latencyMs: res.latencyMs, promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens, reasoningTokens: usage.reasoningTokens,
      reasoningSupported: usage.reasoningSupported, attempts, finishReason, retried, notes,
    };
  }

  /* istanbul ignore next — the loop always returns */
  return {
    ok: false, content: '', error: 'unreachable', errorKind: 'empty-content',
    latencyMs: 0, promptTokens: null, completionTokens: null, reasoningTokens: null,
    reasoningSupported: false, attempts, finishReason: null, retried, notes,
  };
}

/** Live model list. Never gates a run: the UI always allows a hand-typed model name. */
export async function listModels(
  provider: ProviderId,
  baseUrlRaw: string,
  apiKey: string,
): Promise<{ ok: boolean; models: string[]; error: string | null }> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  if (!baseUrl) return { ok: false, models: [], error: 'No base URL set.' };

  const url = `${baseUrl}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, models: [], error: extractProviderError(res.status, text, url) };
    }
    const parsed = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
    const models = (parsed.data ?? [])
      .map((m) => (typeof m?.id === 'string' ? m.id : null))
      .filter((m): m is string => m !== null)
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, models, error: null };
  } catch (err) {
    const real = err instanceof Error ? err.message : String(err);
    return { ok: false, models: [], error: networkError(provider, baseUrl, real) };
  } finally {
    clearTimeout(timer);
  }
}

export function isLocal(provider: ProviderId): boolean {
  return isLocalProvider(provider);
}