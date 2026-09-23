/**
 * Shared wire types. These are the exact shapes the API returns and the UI consumes.
 */

export type ProviderId = 'particle' | 'ollama' | 'lmstudio' | 'openrouter' | 'custom';

export type SlotId = 'A' | 'B';

/** Per-slot model configuration. Keys live only in the browser and in the request body. */
export interface SlotConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export interface SchematicRequest {
  brief: string;
  slotA: SlotConfig;
  slotB: SlotConfig;
}

/** Which extraction path produced the Mermaid source. Recorded, never guessed at. */
export type ExtractionPath =
  | 'mermaid-fence'
  | 'plain-fence'
  | 'bare'
  | 'bare-inline'
  | 'none';

export interface ChecklistItem {
  concept: string;
  present: boolean;
  /** The literal parsed label that matched, e.g. "Retry with backoff". Null when absent. */
  matchedLabel: string | null;
  /** Which regex term hit, so the claim is reproducible. */
  matchedTerm: string | null;
  /** Where it matched: a node label, an edge label, or the raw source fallback. */
  matchedIn: 'node' | 'edge' | 'source' | null;
  /**
   * 1-based line in the diagram source where the matched label can be found.
   *
   * This exists because Mermaid normalises label text as it parses: `<br/>` in the
   * source comes back as `<br>`, and whitespace is collapsed. The matched label is
   * exactly what Mermaid read, so it is reported as-is, and this line number is how a
   * reader verifies the claim against the source anyway.
   */
  sourceLine: number | null;
  /** The literal text of that source line, trimmed. */
  sourceText: string | null;
}

export interface ParseErrorDetail {
  /** Verbatim parser message, unedited. */
  message: string;
  /** 1-based line number the parser complained about, when the message names one. */
  line: number | null;
  /** The literal text of that line, when resolvable. */
  lineText: string | null;
}

export interface AttemptRecord {
  attempt: number;
  maxTokens: number;
  httpStatus: number | null;
  latencyMs: number;
  contentChars: number;
  reasoningCharsStripped: number;
  reasoningTokens: number | null;
  /** The provider's own stop reason. 'length' means the budget ran out mid-answer. */
  finishReason: string | null;
  outcome: 'ok' | 'empty-content' | 'http-error' | 'network-error';
  /** Provider error text, verbatim. */
  error: string | null;
}

export interface DiagramCounts {
  nodes: number;
  edges: number;
  /** Counts are only ever reported from the parsed diagram. */
  source: 'parsed' | 'unavailable';
  note: string | null;
}

export interface ModelResult {
  slot: SlotId;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  /** True only if the model replied AND the diagram parsed. */
  ok: boolean;

  /** Provider/transport failure text, verbatim. Null when the call itself succeeded. */
  error: string | null;
  /** Error class so the UI can render the right hint (e.g. dead local server). */
  errorKind: 'none' | 'config' | 'network' | 'http' | 'empty-content' | 'no-mermaid' | 'parse';

  mermaid: string | null;
  extractionPath: ExtractionPath;
  /** Assistant message content, with any reasoning_content removed. Never contains CoT. */
  rawReply: string;

  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** null means the provider reported no reasoning breakdown. The UI prints "n/a". */
  reasoningTokens: number | null;
  /** Whether this response carried completion_tokens_details.reasoning_tokens at all. */
  reasoningSupported: boolean;

  /**
   * sha256 of the Mermaid source that was parsed. `null` when no source was extracted —
   * never the hash of the empty string, which would look like a real fingerprint of
   * something that does not exist.
   */
  sha256: string | null;
  /** sha256 of the raw reply, so the reply is still identifiable when no source came out. */
  rawReplySha256: string | null;
  /** sha256 of the exact prompt sent, for the zero-prompt-reuse assertion. */
  promptSha256: string;
  nonce: string;
  /** True if this exact prompt hash had already been sent this process lifetime. */
  promptReused: boolean;

  parseOk: boolean;
  parseError: ParseErrorDetail | null;

  counts: DiagramCounts;
  byteCount: number;
  nodeLabels: string[];
  edgeLabels: string[];
  checklist: ChecklistItem[];

  attempts: AttemptRecord[];
  /** The provider's stop reason for the final attempt: 'stop', 'length', ... */
  finishReason: string | null;
  /** True when the answer was cut off by the token ceiling (finish_reason = length). */
  truncated: boolean;
  /** True when the diagram parsed but is degenerate (e.g. nodes with no edges at all). */
  degenerate: boolean;
  /** True when the empty-content retry fired. */
  retried: boolean;
  /**
   * True when this slot was re-run on its own because the local server refused to
   * serve two requests at once (LM Studio answers the second with an instant HTTP 500).
   */
  sequentialRetry: boolean;
  /** Non-fatal notes worth surfacing on camera (e.g. "max_tokens doubled to 3200"). */
  notes: string[];
}

export interface LabelDiff {
  /** Labels present in A but not B. */
  onlyInA: string[];
  /** Labels present in B but not A. */
  onlyInB: string[];
  /** One-line shareable summary. */
  headline: string;
}

export interface SchematicResponse {
  brief: string;
  promptSent: string;
  nonce: string;
  startedAt: string;
  totalLatencyMs: number;
  a: ModelResult;
  b: ModelResult;
  diff: LabelDiff;
  /** Concept-level scoreboard across both diagrams. */
  checklistSummary: Array<{ concept: string; a: boolean; b: boolean }>;
  warnings: string[];
}

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  /** Only Particle ships a hint list; local providers always read live from /v1/models. */
  hintModels: string[];
  /** Live model listing endpoint, relative to baseUrl. */
  modelsPath: string;
  note: string;
}