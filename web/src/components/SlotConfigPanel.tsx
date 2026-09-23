import { useState } from 'react';
import type { ProviderPreset, SlotConfig, SlotId } from '../types';

interface Props {
  slot: SlotId;
  config: SlotConfig;
  presets: ProviderPreset[];
  /** Live models for this slot's provider. Empty when the listing failed. */
  models: string[];
  modelsError: string | null;
  modelsLoading: boolean;
  /**
   * null before the first run. False means the last response carried no
   * completion_tokens_details.reasoning_tokens, so there is nothing to disable and the
   * toggle is hidden rather than shown as a dead control.
   */
  reasoningSupported: boolean | null;
  onChange(patch: Partial<SlotConfig>): void;
  onRefreshModels(): void;
}

export default function SlotConfigPanel({
  slot,
  config,
  presets,
  models,
  modelsError,
  modelsLoading,
  reasoningSupported,
  onChange,
  onRefreshModels,
}: Props) {
  const [open, setOpen] = useState(false);
  const preset = presets.find((p) => p.id === config.provider);
  const listId = `models-${slot}`;
  const showThinkingToggle = reasoningSupported !== false;

  return (
    <section className={`slot-config accent-${slot.toLowerCase()}`}>
      <header className="slot-config-head">
        <span className="slot-tag">{slot}</span>
        <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide config' : 'Configure'}
        </button>
      </header>

      <div className="slot-config-summary">
        <strong>{config.model || 'no model set'}</strong>
        <span className="muted">{preset?.label ?? config.provider}</span>
      </div>

      {open && (
        <div className="slot-config-body">
          <label className="field">
            <span>Provider</span>
            <select
              value={config.provider}
              onChange={(e) => {
                const next = presets.find((p) => p.id === e.target.value);
                onChange({
                  provider: e.target.value as SlotConfig['provider'],
                  // Switching preset adopts its base URL, but keeps any key already typed.
                  baseUrl: next?.baseUrl ?? config.baseUrl,
                });
              }}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.requiresKey ? ' (key required)' : ' (no key)'}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Base URL</span>
            <input
              type="text"
              value={config.baseUrl}
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              onChange={(e) => onChange({ baseUrl: e.target.value })}
            />
          </label>

          <label className="field">
            <span>
              API Key
              {preset && !preset.requiresKey && <em className="muted"> — not needed here</em>}
            </span>
            <input
              type="password"
              value={config.apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder={preset?.requiresKey ? 'paste your key' : 'not required'}
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
          </label>

          <label className="field">
            <span>
              Model
              <button type="button" className="link" onClick={onRefreshModels} disabled={modelsLoading}>
                {modelsLoading ? 'loading…' : 'load from /models'}
              </button>
            </span>
            <input
              type="text"
              list={listId}
              value={config.model}
              spellCheck={false}
              placeholder="type any model name"
              onChange={(e) => onChange({ model: e.target.value })}
            />
            <datalist id={listId}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
              {(models.length === 0 ? preset?.hintModels ?? [] : []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {/* A failed listing is informational. Typing a name by hand always works. */}
            {modelsError && <small className="warn">{modelsError}</small>}
            {!modelsError && models.length > 0 && (
              <small className="muted">{models.length} models from /v1/models — or type one by hand</small>
            )}
          </label>

          <div className="field-row">
            <label className="field">
              <span>Temperature</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={config.temperature}
                onChange={(e) => onChange({ temperature: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Max Tokens</span>
              <input
                type="number"
                step="100"
                min="1"
                max="4000"
                value={config.maxTokens}
                onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
              />
            </label>
          </div>

          {showThinkingToggle ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.disableReasoning}
                onChange={(e) => onChange({ disableReasoning: e.target.checked })}
              />
              <span>
                Disable reasoning
                <small className="muted">
                  {config.provider === 'particle' && config.model.startsWith('deepseek-')
                    ? 'sends chat_template_kwargs.enable_thinking = false'
                    : 'only sent to Particle.ai for deepseek-* models; other providers ignore it'}
                </small>
              </span>
            </label>
          ) : (
            <p className="note">
              Thinking toggle hidden: this slot's last reply carried no
              <code> completion_tokens_details.reasoning_tokens</code>, so it is not a reasoning
              model and there is nothing to disable.
            </p>
          )}
        </div>
      )}
    </section>
  );
}