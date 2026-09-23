import type { ProviderId, ProviderPreset } from './types.js';

/**
 * Provider presets.
 *
 * NO API KEY IS EVER STORED HERE. Keys arrive per-request from the browser's
 * localStorage and are used for exactly one outbound fetch.
 */
export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  particle: {
    id: 'particle',
    label: 'Particle.ai',
    baseUrl: 'https://api.particle.ai/v1',
    requiresKey: true,
    hintModels: ['deepseek-v4.1-flash', 'deepseek-v4-flash-0731', 'glm5.3flash'],
    modelsPath: '/models',
    note: 'Hosted. Sends chat_template_kwargs.enable_thinking=false only for deepseek-* models.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    hintModels: [],
    modelsPath: '/models',
    note: 'Local, no key. Models read live from /v1/models.',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresKey: false,
    hintModels: [],
    modelsPath: '/models',
    note: 'Local, no key. Models read live from /v1/models.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    hintModels: [],
    modelsPath: '/models',
    note: 'Hosted aggregator. Models read live from /v1/models.',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    requiresKey: false,
    hintModels: [],
    modelsPath: '/models',
    note: 'Any OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1',
  },
};

export const PROVIDER_LIST: ProviderPreset[] = [
  PROVIDERS.particle,
  PROVIDERS.ollama,
  PROVIDERS.lmstudio,
  PROVIDERS.openrouter,
  PROVIDERS.custom,
];

export function isLocalProvider(id: ProviderId): boolean {
  return id === 'ollama' || id === 'lmstudio';
}

/**
 * "Disable reasoning" is only safe to transmit to Particle.ai for deepseek-* models.
 * Every other provider either ignores unknown fields or rejects them outright, so we
 * omit the field entirely rather than risk a 400.
 */
export function shouldSendThinkingFlag(
  provider: ProviderId,
  model: string,
  disableReasoning: boolean,
): boolean {
  return provider === 'particle' && model.startsWith('deepseek-') && disableReasoning;
}

/** Strip a trailing slash so `${baseUrl}${path}` never produces a double slash. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}