import type {
  ProviderPreset,
  SchematicResponse,
  SlotConfig,
  ValidationResponse,
} from '../types';

const CONFIG_KEY = 'schematic.config.v1';

export interface StoredConfig {
  brief: string;
  slotA: SlotConfig;
  slotB: SlotConfig;
}

/**
 * Defaults per spec. The API keys are deliberately empty strings: this app never ships
 * a key, and the user pastes one in. Everything else is persisted to localStorage.
 */
export const DEFAULT_CONFIG: StoredConfig = {
  brief: 'a URL shortener at 10M clicks/day',
  slotA: {
    provider: 'particle',
    baseUrl: 'https://api.particle.ai/v1',
    apiKey: '',
    model: 'deepseek-v4-flash-0731',
    temperature: 0,
    maxTokens: 1600,
    disableReasoning: false,
  },
  slotB: {
    provider: 'particle',
    baseUrl: 'https://api.particle.ai/v1',
    apiKey: '',
    model: 'deepseek-v4.1-flash',
    temperature: 0,
    maxTokens: 1600,
    disableReasoning: false,
  },
};

export const PRESET_BRIEFS = [
  'a URL shortener at 10M clicks/day',
  'a payments service with exactly-once semantics',
  'an LLM inference gateway with fallbacks',
  'a realtime chat app for 100k concurrent users',
];

export function loadConfig(): StoredConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    return {
      brief: parsed.brief ?? DEFAULT_CONFIG.brief,
      // Merge per-slot so a config saved by an older build still boots.
      slotA: { ...DEFAULT_CONFIG.slotA, ...parsed.slotA },
      slotB: { ...DEFAULT_CONFIG.slotB, ...parsed.slotB },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: StoredConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* private mode: config simply will not persist */
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Backend returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const message = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

export const fetchProviders = () =>
  fetch('/api/providers')
    .then((r) => r.json() as Promise<{ providers: ProviderPreset[] }>)
    .then((d) => d.providers);

export const runSchematic = (brief: string, slotA: SlotConfig, slotB: SlotConfig) =>
  post<SchematicResponse>('/api/schematic', { brief, slotA, slotB });

export const validateMermaid = (mermaid: string) =>
  post<ValidationResponse>('/api/validate', { mermaid });

/** Model listing never gates a run; callers must treat failure as informational. */
export const fetchModels = (config: SlotConfig) =>
  post<{ ok: boolean; models: string[]; error: string | null }>('/api/models', {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  return n.toLocaleString('en-US');
}

/** Reasoning tokens: a real number when the provider reported one, otherwise "n/a". */
export function formatReasoning(result: {
  reasoningSupported: boolean;
  reasoningTokens: number | null;
}): string {
  if (!result.reasoningSupported || result.reasoningTokens === null) return 'n/a';
  return result.reasoningTokens.toLocaleString('en-US');
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}