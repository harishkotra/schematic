/**
 * Wire contract, mirroring server/src/types.ts.
 * Kept as a local copy so the browser bundle never pulls in server code.
 */

export type ProviderId = 'particle' | 'ollama' | 'lmstudio' | 'openrouter' | 'custom';
export type SlotId = 'A' | 'B';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  hintModels: string[];
  modelsPath: string;
  note: string;
}

export interface SlotConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export type ExtractionPath = 'mermaid-fence' | 'plain-fence' | 'bare' | 'bare-inline' | 'none';

export interface ChecklistItem {
  concept: string;
  present: boolean;
  matchedLabel: string | null;
  matchedTerm: string | null;
  matchedIn: 'node' | 'edge' | 'source' | null;
  sourceLine: number | null;
  sourceText: string | null;
}

export interface ParseErrorDetail {
  message: string;
  line: number | null;
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
  finishReason: string | null;
  outcome: 'ok' | 'empty-content' | 'http-error' | 'network-error';
  error: string | null;
}

export interface DiagramCounts {
  nodes: number;
  edges: number;
  source: 'parsed' | 'unavailable';
  note: string | null;
}

export interface ModelResult {
  slot: SlotId;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  ok: boolean;
  error: string | null;
  errorKind: 'none' | 'config' | 'network' | 'http' | 'empty-content' | 'no-mermaid' | 'parse';
  mermaid: string | null;
  extractionPath: ExtractionPath;
  rawReply: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  reasoningSupported: boolean;
  sha256: string | null;
  rawReplySha256: string | null;
  promptSha256: string;
  nonce: string;
  promptReused: boolean;
  parseOk: boolean;
  parseError: ParseErrorDetail | null;
  counts: DiagramCounts;
  byteCount: number;
  nodeLabels: string[];
  edgeLabels: string[];
  checklist: ChecklistItem[];
  attempts: AttemptRecord[];
  finishReason: string | null;
  truncated: boolean;
  degenerate: boolean;
  retried: boolean;
  sequentialRetry: boolean;
  notes: string[];
}

export interface SchematicResponse {
  brief: string;
  promptSent: string;
  nonce: string;
  startedAt: string;
  totalLatencyMs: number;
  a: ModelResult;
  b: ModelResult;
  diff: { onlyInA: string[]; onlyInB: string[]; headline: string };
  checklistSummary: Array<{ concept: string; a: boolean; b: boolean }>;
  warnings: string[];
}

export interface ValidationResponse {
  parseOk: boolean;
  parseError: ParseErrorDetail | null;
  renderOk: boolean;
  renderError: string | null;
  diagramType: string | null;
  counts: DiagramCounts;
  byteCount: number;
  nodeLabels: string[];
  edgeLabels: string[];
  checklist: ChecklistItem[];
}

export type Phase = 'idle' | 'designing' | 'parsing' | 'rendering' | 'finished' | 'error';