import { createHash, randomBytes } from 'node:crypto';
import { buildChecklist, conceptDiff, headlineFor } from './checklist.js';
import { extractMermaid } from './extract.js';
import { callModel, buildUserPrompt } from './modelCall.js';
import { PROVIDERS } from './providers.js';
import { validateMermaid } from './validate.js';
import type {
  LabelDiff,
  ModelResult,
  SchematicRequest,
  SchematicResponse,
  SlotConfig,
  SlotId,
} from './types.js';

/**
 * Prompt-reuse ledger.
 *
 * Every run appends a fresh random nonce, so two runs can never share a prompt. If a
 * hash ever repeats we surface it loudly instead of quietly returning a cached answer,
 * because a cached reply would fake determinism and invalidate the whole comparison.
 */
const seenPromptHashes = new Set<string>();
let reuseCount = 0;

export function promptReuseStats(): { promptsSeen: number; reuses: number } {
  return { promptsSeen: seenPromptHashes.size, reuses: reuseCount };
}

export function newNonce(): string {
  return randomBytes(6).toString('hex');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Compare labels by meaning, display them as written. */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s/.]/gu, '')
    .trim();
}

function labelSet(labels: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const label of labels) {
    // Single characters are almost always bare node ids, not names worth diffing.
    if (label.trim().length < 2) continue;
    const key = normalizeLabel(label);
    if (!key) continue;
    if (!map.has(key)) map.set(key, label.trim());
  }
  return map;
}

/** Set difference of node labels: the most shareable line in the app. */
function diffLabels(aLabels: string[], bLabels: string[]): { onlyInA: string[]; onlyInB: string[] } {
  const a = labelSet(aLabels);
  const b = labelSet(bLabels);
  const onlyInA = [...a.entries()].filter(([k]) => !b.has(k)).map(([, v]) => v).sort();
  const onlyInB = [...b.entries()].filter(([k]) => !a.has(k)).map(([, v]) => v).sort();
  return { onlyInA, onlyInB };
}

function emptyResult(
  slot: SlotId,
  config: SlotConfig,
  error: string,
  errorKind: ModelResult['errorKind'],
  promptSha256: string,
  nonce: string,
): ModelResult {
  return {
    slot,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    ok: false,
    error,
    errorKind,
    mermaid: null,
    extractionPath: 'none',
    rawReply: '',
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    reasoningSupported: false,
    sha256: null,
    rawReplySha256: null,
    promptSha256,
    nonce,
    promptReused: false,
    parseOk: false,
    parseError: null,
    counts: { nodes: 0, edges: 0, source: 'unavailable', note: 'model was never called' },
    byteCount: 0,
    nodeLabels: [],
    edgeLabels: [],
    checklist: buildChecklist({ nodeLabels: [], edgeLabels: [], source: '' }),
    attempts: [],
    finishReason: null,
    truncated: false,
    degenerate: false,
    retried: false,
    sequentialRetry: false,
    notes: [],
  };
}

async function runSlot(
  slot: SlotId,
  config: SlotConfig,
  prompt: string,
  nonce: string,
  promptSha256: string,
): Promise<ModelResult> {
  const preset = PROVIDERS[config.provider];

  // Fail fast and legibly on obviously incomplete config, rather than sending a request
  // that will come back as a confusing 401.
  if (!config.baseUrl.trim()) {
    return emptyResult(
      slot, config,
      `No Base URL set for slot ${slot}. Pick a provider preset or type a base URL.`,
      'config', promptSha256, nonce,
    );
  }
  if (!config.model.trim()) {
    return emptyResult(
      slot, config,
      `No model name set for slot ${slot}. Pick one from the list or type a name by hand.`,
      'config', promptSha256, nonce,
    );
  }
  if (preset?.requiresKey && !config.apiKey.trim()) {
    return emptyResult(
      slot, config,
      `${preset.label} requires an API key. Paste one into slot ${slot}'s config.`,
      'config', promptSha256, nonce,
    );
  }

  const call = await callModel({ slot, config, prompt });

  const base: ModelResult = {
    slot,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    ok: false,
    error: call.error,
    errorKind: call.errorKind === 'none' ? 'no-mermaid' : call.errorKind,
    mermaid: null,
    extractionPath: 'none',
    rawReply: call.content,
    latencyMs: call.latencyMs,
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
    reasoningTokens: call.reasoningTokens,
    reasoningSupported: call.reasoningSupported,
    sha256: null,
    rawReplySha256: sha256(call.content),
    promptSha256,
    nonce,
    promptReused: false,
    parseOk: false,
    parseError: null,
    counts: { nodes: 0, edges: 0, source: 'unavailable', note: 'no diagram extracted' },
    byteCount: 0,
    nodeLabels: [],
    edgeLabels: [],
    checklist: buildChecklist({ nodeLabels: [], edgeLabels: [], source: '' }),
    attempts: call.attempts,
    finishReason: call.finishReason,
    truncated: call.finishReason === 'length',
    degenerate: false,
    retried: call.retried,
    sequentialRetry: false,
    notes: call.notes,
  };

  if (!call.ok) return base;

  const extraction = extractMermaid(call.content);
  base.extractionPath = extraction.path;
  if (extraction.note) base.notes.push(extraction.note);

  if (!extraction.source) {
    base.errorKind = 'no-mermaid';
    base.error = `No Mermaid diagram found in the reply. ${extraction.note ?? ''}`.trim();
    return base;
  }

  base.mermaid = extraction.source;
  base.sha256 = sha256(extraction.source);
  base.byteCount = Buffer.byteLength(extraction.source, 'utf8');

  const validation = await validateMermaid(extraction.source);
  base.parseOk = validation.parseOk;
  base.parseError = validation.parseError;
  base.counts = validation.counts;
  base.nodeLabels = validation.nodeLabels;
  base.edgeLabels = validation.edgeLabels;
  base.checklist = buildChecklist({
    nodeLabels: validation.nodeLabels,
    edgeLabels: validation.edgeLabels,
    source: extraction.source,
  });

  if (!validation.parseOk) {
    base.errorKind = 'parse';
    base.error = validation.parseError?.message ?? 'Mermaid failed to parse the diagram.';
    return base;
  }

  // Parsing is not proof it draws. If the renderer failed, say so with its real error.
  if (!validation.renderOk) {
    base.errorKind = 'parse';
    base.error = `Parsed, but Mermaid failed to render it:\n${validation.renderError ?? '(no message)'}`;
    return base;
  }

  /**
   * A diagram can parse perfectly and still be useless.
   *
   * When a reply is cut off by the token ceiling, the fragment that survives is often a
   * handful of node declarations with no edges. Mermaid accepts it, the badge says
   * PARSED, and the checklist dutifully reports everything as missing — which looks like
   * a model failure when it is really a truncation. Flag it explicitly.
   */
  if (base.counts.source === 'parsed' && base.counts.nodes > 1 && base.counts.edges === 0) {
    base.degenerate = true;
    base.notes.push(
      `This diagram parsed but has ${base.counts.nodes} nodes and no edges at all — it is almost certainly a truncated or malformed fragment rather than a real architecture.`,
    );
  }

  base.ok = true;
  base.error = null;
  base.errorKind = 'none';
  return base;
}

/** Loopback and private-range hosts, where a model server is almost certainly running. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Did a *local* server reject this request with an HTTP error?
 *
 * LM Studio serves exactly one request at a time and answers a second simultaneous one
 * with an instant HTTP 500 (occasionally 400) before it has even looked at the body.
 * We only treat this as a concurrency refusal when the target is local; a hosted
 * provider returning 5xx is a real upstream failure and is reported as such.
 */
export function isLocalConcurrencyRefusal(result: ModelResult): boolean {
  if (result.errorKind !== 'http') return false;
  const status = result.attempts[0]?.httpStatus ?? null;
  if (status === null || status < 400 || status >= 600) return false;
  return result.provider === 'ollama' || result.provider === 'lmstudio' || isLocalBaseUrl(result.baseUrl);
}

export async function runSchematic(req: SchematicRequest): Promise<SchematicResponse> {
  const warnings: string[] = [];
  const brief = req.brief.trim();
  if (!brief) throw new Error('brief is required');

  const nonce = newNonce();
  const prompt = buildUserPrompt(brief, nonce);
  const promptSha256 = sha256(prompt);

  if (seenPromptHashes.has(promptSha256)) {
    reuseCount += 1;
    warnings.push(
      `PROMPT REUSE DETECTED: prompt hash ${promptSha256.slice(0, 12)} was already sent. ` +
        'A response cache could be faking this result.',
    );
  }
  const promptReused = seenPromptHashes.has(promptSha256);
  seenPromptHashes.add(promptSha256);

  const started = Date.now();

  // Both slots get the byte-identical prompt and run concurrently.
  let [a, b] = await Promise.all([
    runSlot('A', req.slotA, prompt, nonce, promptSha256),
    runSlot('B', req.slotB, prompt, nonce, promptSha256),
  ]);

  /**
   * Concurrency recovery for single-threaded local servers.
   *
   * When exactly one slot was refused by a local server while the other succeeded, that
   * is the local server serialising, not a bad request. Re-running the refused slot on
   * its own costs one extra call and makes local providers work as required. If the
   * error was genuine it simply recurs and is reported verbatim, so nothing is masked.
   */
  const refusedA = isLocalConcurrencyRefusal(a);
  const refusedB = isLocalConcurrencyRefusal(b);
  if (refusedA !== refusedB) {
    const slot: SlotId = refusedA ? 'A' : 'B';
    const config = slot === 'A' ? req.slotA : req.slotB;
    const first = slot === 'A' ? a : b;
    const status = first.attempts[0]?.httpStatus ?? 'error';

    const retry = await runSlot(slot, config, prompt, nonce, promptSha256);
    retry.sequentialRetry = true;
    retry.notes.unshift(
      `Local server refused the concurrent request (HTTP ${status}), so this slot was re-run on its own. ` +
        'Single-instance local servers such as LM Studio serve one request at a time.',
    );

    const note = `Slot ${slot}: local server refused the concurrent request (HTTP ${status}); re-ran it sequentially and it ${retry.ok ? 'succeeded' : 'still failed'}.`;
    warnings.push(note);
    if (slot === 'A') a = retry;
    else b = retry;
  }

  // Both results carry the same verdict: this prompt was (or was not) seen before.
  a.promptReused = promptReused;
  b.promptReused = promptReused;

  const { onlyInA, onlyInB } = diffLabels(a.nodeLabels, b.nodeLabels);
  const checklistSummary = conceptDiff(a.checklist, b.checklist);

  if (!a.ok) warnings.push(`Slot A did not produce a rendered diagram: ${a.errorKind}`);
  if (!b.ok) warnings.push(`Slot B did not produce a rendered diagram: ${b.errorKind}`);
  if (a.counts.source !== 'parsed' && a.parseOk) warnings.push(`Slot A node/edge counts unavailable: ${a.counts.note}`);
  if (b.counts.source !== 'parsed' && b.parseOk) warnings.push(`Slot B node/edge counts unavailable: ${b.counts.note}`);
  for (const m of [a, b]) {
    if (m.truncated) {
      warnings.push(`Slot ${m.slot}: the model hit the max_tokens ceiling (finish_reason=length); its diagram may be incomplete.`);
    }
    if (m.degenerate) {
      warnings.push(`Slot ${m.slot}: the diagram parsed but contains no edges — treat it as a fragment, not an architecture.`);
    }
  }

  const diff: LabelDiff = {
    onlyInA,
    onlyInB,
    headline: headlineFor(onlyInB, onlyInA, checklistSummary),
  };

  return {
    brief,
    promptSent: prompt,
    nonce,
    startedAt: new Date(started).toISOString(),
    totalLatencyMs: Date.now() - started,
    a,
    b,
    diff,
    checklistSummary,
    warnings,
  };
}