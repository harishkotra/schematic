import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChecklistPanel from './components/ChecklistPanel';
import DiagramPanel from './components/DiagramPanel';
import DiffStrip from './components/DiffStrip';
import SlotConfigPanel from './components/SlotConfigPanel';
import {
  DEFAULT_CONFIG,
  PRESET_BRIEFS,
  downloadBlob,
  downloadText,
  fetchModels,
  fetchProviders,
  formatMs,
  loadConfig,
  runSchematic,
  saveConfig,
  validateMermaid,
} from './lib/config';
import { parseMermaid, renderMermaid, standaloneSvg } from './lib/mermaidClient';
import { diffNodeLabels, emptyPanel, panelFromResult, panelFromValidation, type PanelState } from './lib/panel';
import { buildShareCard } from './lib/shareCard';
import type {
  ModelResult,
  Phase,
  ProviderPreset,
  SchematicResponse,
  SlotConfig,
  SlotId,
} from './types';

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'idle',
  designing: 'designing — models are writing Mermaid',
  parsing: 'parsing — mermaid.js is checking the syntax',
  rendering: 'rendering — drawing SVG',
  finished: 'finished',
  error: 'error',
};

interface SlotExtras {
  models: string[];
  modelsError: string | null;
  modelsLoading: boolean;
}

const NO_EXTRAS: SlotExtras = { models: [], modelsError: null, modelsLoading: false };

export default function App() {
  const [config, setConfig] = useState(() => loadConfig());
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [extras, setExtras] = useState<Record<SlotId, SlotExtras>>({ A: NO_EXTRAS, B: NO_EXTRAS });

  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<SchematicResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panels, setPanels] = useState<Record<SlotId, PanelState | null>>({ A: null, B: null });
  const [busySlot, setBusySlot] = useState<SlotId | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const runIdRef = useRef(0);

  // ── persistence ────────────────────────────────────────────────────────────
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    fetchProviders()
      .then(setProviders)
      .catch((err: Error) => setError(`Could not load provider presets: ${err.message}`));
  }, []);

  const setSlot = useCallback((slot: SlotId, patch: Partial<SlotConfig>) => {
    setConfig((prev) => ({ ...prev, [slot === 'A' ? 'slotA' : 'slotB']: { ...prev[slot === 'A' ? 'slotA' : 'slotB'], ...patch } }));
  }, []);

  /**
   * Model listing is a convenience, never a gate. A failure here is displayed and then
   * ignored: the user can always type a model name by hand.
   */
  const loadModels = useCallback(async (slot: SlotId, slotConfig: SlotConfig) => {
    setExtras((prev) => ({ ...prev, [slot]: { ...prev[slot], modelsLoading: true } }));
    try {
      const res = await fetchModels(slotConfig);
      setExtras((prev) => ({
        ...prev,
        [slot]: { models: res.models, modelsError: res.ok ? null : res.error, modelsLoading: false },
      }));
    } catch (err) {
      setExtras((prev) => ({
        ...prev,
        [slot]: { models: [], modelsError: (err as Error).message, modelsLoading: false },
      }));
    }
  }, []);

  useEffect(() => {
    if (providers.length === 0) return;
    void loadModels('A', config.slotA);
    void loadModels('B', config.slotB);
    // Only when the provider changes: the base URL may still be mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length, config.slotA.provider, config.slotB.provider]);

  // ── the run ────────────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    const runId = ++runIdRef.current;
    setError(null);
    setResult(null);
    setPanels({ A: null, B: null });
    setPhase('designing');
    setBusySlot('A');

    try {
      const res = await runSchematic(config.brief, config.slotA, config.slotB);
      if (runId !== runIdRef.current) return;
      setResult(res);
      setBusySlot(null);

      const sources: Record<SlotId, string> = {
        A: res.a.mermaid ?? '',
        B: res.b.mermaid ?? '',
      };

      // Real parse in the browser, then real render. Both stages actually run.
      setPhase('parsing');
      const parsed = await Promise.all([
        sources.A ? parseMermaid(sources.A) : Promise.resolve({ ok: false, error: null }),
        sources.B ? parseMermaid(sources.B) : Promise.resolve({ ok: false, error: null }),
      ]);
      if (runId !== runIdRef.current) return;

      setPhase('rendering');
      const rendered = await Promise.all([
        sources.A ? renderMermaid('schematic-a', sources.A) : Promise.resolve({ svg: null, error: null }),
        sources.B ? renderMermaid('schematic-b', sources.B) : Promise.resolve({ svg: null, error: null }),
      ]);
      if (runId !== runIdRef.current) return;

      const build = (slot: SlotId, model: ModelResult, client: { svg: string | null; error: string | null }, parse: { ok: boolean; error: string | null }): PanelState => {
        const base = panelFromResult(model);
        return {
          ...base,
          source: sources[slot],
          svg: client.svg,
          clientError: client.error ?? (sources[slot] && !parse.ok ? parse.error : null),
          // The server's verdict is authoritative; the browser is the tiebreak.
          parseOk: base.parseOk,
        };
      };

      setPanels({
        A: (sources.A || res.a.errorKind === 'none') ? build('A', res.a, rendered[0], parsed[0]) : emptyPanel(),
        B: (sources.B || res.b.errorKind === 'none') ? build('B', res.b, rendered[1], parsed[1]) : emptyPanel(),
      });
      setPhase('finished');
    } catch (err) {
      if (runId !== runIdRef.current) return;
      setError((err as Error).message);
      setPhase('error');
      setBusySlot(null);
    }
  }, [config]);

  // ── live re-render of an edited panel ──────────────────────────────────────
  const rerenderSlot = useCallback(
    async (slot: SlotId) => {
      const panel = panels[slot];
      if (!panel) return;
      setBusySlot(slot);
      try {
        // Server-side validation is authoritative for counts, labels and the checklist.
        const validation = await validateMermaid(panel.source);
        const client = await renderMermaid(`schematic-${slot.toLowerCase()}-edit`, panel.source);
        const original = slot === 'A' ? result?.a.mermaid : result?.b.mermaid;
        setPanels((prev) => ({
          ...prev,
          [slot]: panelFromValidation(
            validation,
            panel.source,
            client.svg,
            client.error,
            panel.source !== (original ?? ''),
          ),
        }));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusySlot(null);
      }
    },
    [panels, result],
  );

  const onSourceChange = useCallback((slot: SlotId, source: string) => {
    setPanels((prev) => (prev[slot] ? { ...prev, [slot]: { ...prev[slot]!, source } } : prev));
  }, []);

  // ── exports ────────────────────────────────────────────────────────────────
  const downloadSvg = useCallback(
    (slot: SlotId) => {
      const svg = panels[slot]?.svg;
      if (!svg) return;
      const model = (slot === 'A' ? config.slotA.model : config.slotB.model) || slot;
      const safe = model.replace(/[^a-z0-9._-]+/gi, '_');
      downloadText(`schematic-${slot}-${safe}.svg`, standaloneSvg(svg), 'image/svg+xml');
    },
    [panels, config],
  );

  const copyJson = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setToast('Results copied as JSON.');
    } catch (err) {
      setToast(`Clipboard refused: ${(err as Error).message}`);
    }
  }, [result]);

  const shareCard = useCallback(async () => {
    if (!result) return;
    setCardBusy(true);
    try {
      const blob = await buildShareCard({
        brief: result.brief,
        headline: result.diff.headline,
        a: { label: config.slotA.model, svg: panels.A?.svg ?? null },
        b: { label: config.slotB.model, svg: panels.B?.svg ?? null },
        checklist: result.checklistSummary,
        nonce: result.nonce,
      });
      downloadBlob(`schematic-share-${result.nonce}.png`, blob);
      setToast('Share card downloaded (1080×1080 PNG).');
    } catch (err) {
      setToast(`Share card failed: ${(err as Error).message}`);
    } finally {
      setCardBusy(false);
    }
  }, [result, panels, config]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── derived ────────────────────────────────────────────────────────────────
  const diff = useMemo(() => {
    const a = panels.A?.nodeLabels ?? result?.a.nodeLabels ?? [];
    const b = panels.B?.nodeLabels ?? result?.b.nodeLabels ?? [];
    if (a.length === 0 && b.length === 0) {
      return { onlyInA: result?.diff.onlyInA ?? [], onlyInB: result?.diff.onlyInB ?? [] };
    }
    return diffNodeLabels(a, b);
  }, [panels, result]);

  const checklistA = panels.A?.checklist?.length ? panels.A.checklist : result?.a.checklist ?? [];
  const checklistB = panels.B?.checklist?.length ? panels.B.checklist : result?.b.checklist ?? [];

  /**
   * Capability is per slot. A slot whose reply carried no
   * completion_tokens_details.reasoning_tokens is not a reasoning model, so its thinking
   * toggle is hidden — even if the other slot is one. Before the first run we have no
   * evidence either way, so both toggles show (null).
   */
  const reasoningSupportedFor = useCallback(
    (slot: SlotId): boolean | null => {
      const m = slot === 'A' ? result?.a : result?.b;
      return m ? m.reasoningSupported : null;
    },
    [result],
  );

  const anyEdited = Boolean(panels.A?.edited || panels.B?.edited);
  const running = phase === 'designing' || phase === 'parsing' || phase === 'rendering';

  /** The panel placeholder should describe the stage actually running. */
  const busyLabel =
    phase === 'designing' ? 'waiting for the model…'
    : phase === 'parsing' ? 'parsing with mermaid.js…'
    : phase === 'rendering' ? 'rendering SVG…'
    : 'working…';

  return (
    <div className="app">
      <header className="app-head">
        <div className="brand">
          <h1>Schematic</h1>
          <p>
            One identical system-design prompt, two models, one Mermaid flowchart each. The
            checklist is the payload.
          </p>
        </div>
        <div className={`phase phase-${phase}`}>
          <span className="phase-dot" />
          <span className="phase-text">{PHASE_LABEL[phase]}</span>
          {result && <span className="muted small">{formatMs(result.totalLatencyMs)} total</span>}
        </div>
      </header>

      <section className="brief-bar">
        <label className="brief-input">
          <span>Brief</span>
          <input
            type="text"
            value={config.brief}
            spellCheck={false}
            placeholder="a URL shortener at 10M clicks/day"
            onChange={(e) => setConfig((prev) => ({ ...prev, brief: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) void run();
            }}
          />
        </label>
        <button type="button" className="run" onClick={() => void run()} disabled={running}>
          {running ? 'Working…' : 'Design both'}
        </button>
      </section>

      <div className="presets">
        {PRESET_BRIEFS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`preset ${config.brief === preset ? 'active' : ''}`}
            onClick={() => setConfig((prev) => ({ ...prev, brief: preset }))}
          >
            {preset}
          </button>
        ))}
        <button
          type="button"
          className="preset reset"
          onClick={() => setConfig({ ...DEFAULT_CONFIG, brief: config.brief })}
        >
          reset config
        </button>
      </div>

      <section className="config-grid">
        {(['A', 'B'] as SlotId[]).map((slot) => (
          <SlotConfigPanel
            key={slot}
            slot={slot}
            config={slot === 'A' ? config.slotA : config.slotB}
            presets={providers}
            models={extras[slot].models}
            modelsError={extras[slot].modelsError}
            modelsLoading={extras[slot].modelsLoading}
            reasoningSupported={reasoningSupportedFor(slot)}
            onChange={(patch) => setSlot(slot, patch)}
            onRefreshModels={() => void loadModels(slot, slot === 'A' ? config.slotA : config.slotB)}
          />
        ))}
      </section>

      {error && (
        <div className="banner error">
          <strong>Request failed.</strong>
          <pre className="verbatim">{error}</pre>
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <div className="banner warn">
          <strong>Warnings</strong>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="diagram-grid">
        <DiagramPanel
          slot="A"
          model={result?.a.model ?? config.slotA.model}
          providerLabel={providers.find((p) => p.id === config.slotA.provider)?.label ?? config.slotA.provider}
          panel={panels.A}
          result={result?.a ?? null}
          busy={running || busySlot === 'A'}
          busyLabel={busyLabel}
          onSourceChange={(src) => onSourceChange('A', src)}
          onRerender={() => void rerenderSlot('A')}
          onDownloadSvg={() => downloadSvg('A')}
        />
        <DiagramPanel
          slot="B"
          model={result?.b.model ?? config.slotB.model}
          providerLabel={providers.find((p) => p.id === config.slotB.provider)?.label ?? config.slotB.provider}
          panel={panels.B}
          result={result?.b ?? null}
          busy={running || busySlot === 'B'}
          busyLabel={busyLabel}
          onSourceChange={(src) => onSourceChange('B', src)}
          onRerender={() => void rerenderSlot('B')}
          onDownloadSvg={() => downloadSvg('B')}
        />
      </section>

      {result && (
        <DiffStrip
          headline={result.diff.headline}
          onlyInA={diff.onlyInA}
          onlyInB={diff.onlyInB}
          aLabel={result.a.model}
          bLabel={result.b.model}
          stale={anyEdited}
        />
      )}

      {result && checklistA.length > 0 && (
        <ChecklistPanel
          a={checklistA}
          b={checklistB}
          aLabel={result.a.model}
          bLabel={result.b.model}
        />
      )}

      <section className="export-bar">
        <button type="button" className="primary" onClick={() => void shareCard()} disabled={!result || cardBusy}>
          {cardBusy ? 'Building card…' : 'Download 1080×1080 share card'}
        </button>
        <button type="button" className="ghost" onClick={() => void copyJson()} disabled={!result}>
          Copy results as JSON
        </button>
        <button type="button" className="ghost" onClick={() => downloadSvg('A')} disabled={!panels.A?.svg}>
          Download SVG (A)
        </button>
        <button type="button" className="ghost" onClick={() => downloadSvg('B')} disabled={!panels.B?.svg}>
          Download SVG (B)
        </button>
      </section>

      {result && (
        <details className="prompt-details">
          <summary>The exact prompt both models received</summary>
          <pre className="verbatim">{result.promptSent}</pre>
          <p className="muted small">
            Nonce <code>{result.nonce}</code> · prompt sha256{' '}
            <code>{result.a.promptSha256.slice(0, 24)}…</code> · reuse detected:{' '}
            <strong>{result.a.promptReused ? 'YES' : 'no'}</strong>
          </p>
        </details>
      )}

      <footer className="site-footer">
        <span>
          Built by{' '}
          <a href="https://harishkotra.me" target="_blank" rel="noopener noreferrer">
            Harish Kotra
          </a>
        </span>
        <span className="footer-dot" aria-hidden="true">
          ·
        </span>
        <span>
          Checkout my other builds at{' '}
          <a href="https://dailybuild.xyz" target="_blank" rel="noopener noreferrer">
            dailybuild.xyz
          </a>
        </span>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}