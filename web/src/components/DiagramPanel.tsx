import { useState } from 'react';
import { formatMs, formatNumber, formatReasoning } from '../lib/config';
import type { PanelState } from '../lib/panel';
import type { ModelResult, SlotId } from '../types';

interface Props {
  slot: SlotId;
  model: string;
  providerLabel: string;
  panel: PanelState | null;
  result: ModelResult | null;
  busy: boolean;
  /** What the current phase is doing, shown in the placeholder. */
  busyLabel: string;
  onSourceChange(source: string): void;
  onRerender(): void;
  onDownloadSvg(): void;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export default function DiagramPanel({
  slot,
  model,
  providerLabel,
  panel,
  result,
  busy,
  busyLabel,
  onSourceChange,
  onRerender,
  onDownloadSvg,
}: Props) {
  const [editorOpen, setEditorOpen] = useState(false);

  const accent = slot.toLowerCase();
  const parsed = panel?.parseOk ?? false;
  const rendered = Boolean(panel?.svg);
  const failed = panel !== null && (!parsed || !rendered);

  // The authoritative error: the parser's own words, or the renderer's.
  const errorText =
    panel?.parseError?.message ??
    panel?.clientError ??
    panel?.renderError ??
    result?.error ??
    null;

  return (
    <section className={`diagram-panel accent-${accent} ${failed ? 'is-failed' : ''}`}>
      <header className="panel-head">
        <span className="slot-tag big">{slot}</span>
        <div className="panel-title">
          <h2>{model || 'no model'}</h2>
          <p className="muted">{providerLabel}</p>
        </div>
        <span
          className={`badge ${busy ? 'busy' : !result ? 'idle' : parsed && rendered ? 'ok' : 'bad'}`}
        >
          {busy ? 'WORKING' : !result ? 'IDLE' : parsed && rendered ? 'PARSED' : 'FAILED'}
        </span>
      </header>

      {result && (
        <div className="stats">
          <Stat
            label="nodes"
            value={panel?.counts.source === 'parsed' ? String(panel.counts.nodes) : 'n/a'}
            hint={panel?.counts.note ?? 'counted from the parsed diagram'}
          />
          <Stat
            label="edges"
            value={panel?.counts.source === 'parsed' ? String(panel.counts.edges) : 'n/a'}
            hint={panel?.counts.note ?? 'counted from the parsed diagram'}
          />
          <Stat label="source bytes" value={formatNumber(panel?.byteCount ?? 0)} />
          <Stat label="latency" value={formatMs(result.latencyMs)} />
          <Stat label="prompt tok" value={formatNumber(result.promptTokens)} />
          <Stat label="completion tok" value={formatNumber(result.completionTokens)} />
          <Stat
            label="reasoning tok"
            value={formatReasoning(result)}
            hint={
              result.reasoningSupported
                ? 'reported by the provider in usage.completion_tokens_details.reasoning_tokens'
                : 'this provider reported no reasoning token breakdown'
            }
          />
          <Stat label="extracted via" value={result.extractionPath} />
          <Stat
            label="finish reason"
            value={result.finishReason ?? 'n/a'}
            hint="The provider's own stop reason. 'length' means the token ceiling cut the answer off."
          />
        </div>
      )}

      {result && (
        <p className="meta-line">
          <span className="muted">sha256</span>{' '}
          {result.sha256 ? (
            <code title={`sha256 of the Mermaid source: ${result.sha256}`}>
              {result.sha256.slice(0, 16)}…
            </code>
          ) : (
            <code className="muted" title="No Mermaid source was extracted, so there is nothing to fingerprint.">
              n/a
            </code>
          )}
          <span className="muted"> · nonce</span> <code>{result.nonce}</code>
          {result.retried && <span className="pill warn">retried with a doubled budget</span>}
          {result.truncated && (
            <span className="pill warn" title="The provider stopped at the max_tokens ceiling, so the reply may be cut off mid-diagram.">
              truncated at max_tokens
            </span>
          )}
          {result.degenerate && (
            <span className="pill danger" title="This diagram parsed but has nodes and no edges at all.">
              no edges — likely a fragment
            </span>
          )}
          {result.sequentialRetry && (
            <span className="pill warn" title="Local servers such as LM Studio serve one request at a time, so this slot was re-run on its own.">
              re-run alone (local server refused the concurrent request)
            </span>
          )}
          {panel?.edited && <span className="pill">edited by hand</span>}
        </p>
      )}

      {failed && errorText && (
        <div className="error-block">
          <h3>Mermaid refused this diagram — verbatim error</h3>
          <pre className="verbatim">{errorText}</pre>
          {panel?.parseError?.line !== null && panel?.parseError?.line !== undefined && (
            <div className="offending">
              <span className="offending-label">offending line {panel.parseError.line}</span>
              <pre className="verbatim line">
                {panel.parseError.lineText ?? '(line not resolvable in the extracted source)'}
              </pre>
            </div>
          )}
          {panel?.clientError && panel?.parseError?.message !== panel.clientError && (
            <div className="offending">
              <span className="offending-label">browser renderer said</span>
              <pre className="verbatim">{panel.clientError}</pre>
            </div>
          )}
        </div>
      )}

      <div className="canvas">
        {busy && <div className="placeholder">{busyLabel}</div>}
        {!busy && panel?.svg && (
          <div className="svg-host" dangerouslySetInnerHTML={{ __html: panel.svg }} />
        )}
        {!busy && !panel?.svg && !failed && (
          <div className="placeholder">no diagram yet</div>
        )}
        {!busy && !panel?.svg && failed && (
          <div className="placeholder failed-placeholder">nothing rendered — see the error above</div>
        )}
      </div>

      <div className="panel-actions">
        <button type="button" className="ghost" onClick={() => setEditorOpen((v) => !v)}>
          {editorOpen ? 'Hide source' : 'Edit source'}
        </button>
        <button type="button" className="primary" onClick={onRerender} disabled={!panel?.source.trim()}>
          Re-render
        </button>
        <button type="button" className="ghost" onClick={onDownloadSvg} disabled={!panel?.svg}>
          Download SVG
        </button>
      </div>

      {editorOpen && (
        <div className="editor">
          <label className="editor-label" htmlFor={`editor-${slot}`}>
            Mermaid source — edit and press Re-render. A broken diagram is a feature: the parser's
            exact words appear above.
          </label>
          <textarea
            id={`editor-${slot}`}
            value={panel?.source ?? ''}
            spellCheck={false}
            onChange={(e) => onSourceChange(e.target.value)}
          />
        </div>
      )}

      {failed && panel?.source && (
        <details className="raw-source" open>
          <summary>Raw Mermaid source ({formatNumber(panel.byteCount)} bytes)</summary>
          <pre className="verbatim">{panel.source}</pre>
        </details>
      )}

      {result?.errorKind === 'no-mermaid' && result.rawReply && (
        <details className="raw-source" open>
          <summary>The reply contained no Mermaid diagram — here is what the model actually said</summary>
          <pre className="verbatim">{result.rawReply}</pre>
        </details>
      )}

      {result && (result.notes.length > 0 || result.attempts.length > 1) && (
        <details className="diagnostics">
          <summary>Diagnostics</summary>
          <ul>
            {result.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
            {result.attempts.map((a) => (
              <li key={a.attempt}>
                attempt {a.attempt}: HTTP {a.httpStatus ?? '—'}, max_tokens {a.maxTokens},{' '}
                {a.contentChars} content chars, {a.reasoningCharsStripped} CoT chars stripped,{' '}
                reasoning {a.reasoningTokens === null ? 'n/a' : a.reasoningTokens} → {a.outcome}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Chain-of-thought text is never logged, stored or displayed. Only its character count
            appears here, as a diagnostic.
          </p>
        </details>
      )}
    </section>
  );
}