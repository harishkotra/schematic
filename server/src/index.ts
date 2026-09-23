import cors from 'cors';
import express from 'express';
import { buildChecklist } from './checklist.js';
import { listModels } from './modelCall.js';
import { PROVIDER_LIST } from './providers.js';
import { promptReuseStats, runSchematic } from './run.js';
import { validateMermaid } from './validate.js';
import type { ProviderId, SchematicRequest, SlotConfig } from './types.js';

const app = express();
const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);

app.use(cors());
app.use(express.json({ limit: '4mb' }));

/**
 * Every route answers with JSON, always.
 *
 * A thrown handler would otherwise let Express emit its default HTML error page, and the
 * browser client would report that as a confusing parse failure instead of the real
 * problem. These guards make a genuine crash legible.
 */
function fail(res: express.Response, err: unknown, what: string): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? `\n${err.stack.split('\n').slice(0, 4).join('\n')}` : '';
  console.error(`[schematic] ${what} failed: ${message}`);
  res.status(500).json({ error: `${what} failed: ${message}${stack}`, ok: false });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'schematic', port: PORT, promptReuse: promptReuseStats() });
});

/** Presets are served from the backend so the UI and the request builder cannot drift. */
app.get('/api/providers', (_req, res) => {
  res.json({ providers: PROVIDER_LIST });
});

/**
 * Live model list for one slot. A failure here is informational only — the UI keeps
 * the hand-typed model name and never blocks a run on this succeeding.
 */
app.post('/api/models', async (req, res) => {
  try {
    const body = req.body as Partial<SlotConfig> & { provider?: ProviderId };
    if (!body?.provider) {
      res.status(400).json({ ok: false, models: [], error: 'provider is required' });
      return;
    }
    const result = await listModels(body.provider, body.baseUrl ?? '', body.apiKey ?? '');
    res.json(result);
  } catch (err) {
    fail(res, err, 'listing models');
  }
});

/**
 * Server-side validation of arbitrary Mermaid, used by the per-panel source editor and
 * the "re-render" button. This is what surfaces a verbatim parse error for a
 * deliberately broken diagram.
 */
app.post('/api/validate', async (req, res) => {
  try {
    const body = req.body as { mermaid?: unknown };
    if (typeof body?.mermaid !== 'string') {
      res.status(400).json({ ok: false, error: 'mermaid (string) is required' });
      return;
    }
    const source = body.mermaid;
    const validation = await validateMermaid(source);
    res.json({
      parseOk: validation.parseOk,
      parseError: validation.parseError,
      renderOk: validation.renderOk,
      renderError: validation.renderError,
      diagramType: validation.diagramType,
      counts: validation.counts,
      byteCount: Buffer.byteLength(source, 'utf8'),
      nodeLabels: validation.nodeLabels,
      edgeLabels: validation.edgeLabels,
      checklist: buildChecklist({
        nodeLabels: validation.nodeLabels,
        edgeLabels: validation.edgeLabels,
        source,
      }),
    });
  } catch (err) {
    fail(res, err, 'validating Mermaid');
  }
});

app.post('/api/schematic', async (req, res) => {
  try {
    const body = req.body as Partial<SchematicRequest>;
    if (typeof body?.brief !== 'string' || !body.brief.trim()) {
      res.status(400).json({ error: 'brief (non-empty string) is required' });
      return;
    }
    if (!body.slotA || !body.slotB) {
      res.status(400).json({ error: 'slotA and slotB configs are required' });
      return;
    }

    const result = await runSchematic({ brief: body.brief, slotA: body.slotA, slotB: body.slotB });
    res.json(result);
  } catch (err) {
    fail(res, err, 'running the schematic');
  }
});

// JSON for unknown routes and for anything the handlers missed.
app.use((_req, res) => {
  res.status(404).json({ error: 'No such route.' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  fail(res, err, 'handling the request');
});

/**
 * A long-running dev tool should survive a stray rejection rather than vanish mid-run,
 * which is exactly what a silent death would look like from the UI.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[schematic] unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[schematic] uncaught exception:', err.stack ?? err);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[schematic] API on http://127.0.0.1:${PORT}`);
  console.log('[schematic] keys are supplied per request from the browser; none are stored server-side.');
});