import { ensureMermaid, withMermaidLock } from './dom.js';
import type { DiagramCounts, ParseErrorDetail } from './types.js';

export interface GraphRead {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ start: string; end: string; label: string }>;
  note: string | null;
}

export interface ValidationResult {
  diagramType: string | null;
  parseOk: boolean;
  parseError: ParseErrorDetail | null;
  /** We do not claim success without rendering. Render can fail where parse succeeds. */
  renderOk: boolean;
  renderError: string | null;
  svg: string | null;
  counts: DiagramCounts;
  nodeLabels: string[];
  edgeLabels: string[];
}

function normalizeCollection(value: unknown): unknown[] {
  if (!value) return [];
  if (value instanceof Map) return [...value.values()];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Flowcharts are the requested output, so that path is explicit and exact.
 * `db.vertices` is a Map and `db.edges` an Array in Mermaid v11 — note that
 * `db.getVertices()` returns `{}` in v11, which is why we read the fields directly.
 */
function readFlowchart(db: Record<string, unknown>): GraphRead | null {
  const vertices = db.vertices;
  const rawEdges = db.edges;
  if (!vertices || !rawEdges) return null;

  const nodes = normalizeCollection(vertices).map((v) => {
    const node = v as Record<string, unknown>;
    return {
      id: str(node.id),
      label: str(node.text ?? node.label ?? node.id),
    };
  });

  const edges = normalizeCollection(rawEdges).map((e) => {
    const edge = e as Record<string, unknown>;
    return {
      start: str(edge.start ?? edge.from),
      end: str(edge.end ?? edge.to),
      label: str(edge.text ?? edge.label ?? ''),
    };
  });

  return { nodes, edges, note: null };
}

/**
 * Best-effort reader for the non-flowchart diagram types Mermaid may return anyway.
 * If nothing matches we report counts as unavailable rather than inventing a number.
 */
function readGeneric(db: Record<string, unknown>): GraphRead | null {
  const call = (name: string): unknown => {
    const fn = db[name];
    return typeof fn === 'function' ? (fn as () => unknown).call(db) : undefined;
  };

  const actorLike = call('getActors') ?? call('getClasses') ?? call('getEntities') ?? call('getStates');
  const edgeLike = call('getMessages') ?? call('getRelations') ?? call('getRelationships') ?? call('getTransitions');
  if (!actorLike && !edgeLike) return null;

  const nodes = normalizeCollection(actorLike).map((a) => {
    const node = a as Record<string, unknown>;
    return {
      id: str(node.id ?? node.name ?? node.alias),
      label: str(node.description ?? node.label ?? node.name ?? node.id ?? node.alias),
    };
  });

  const edges = normalizeCollection(edgeLike).map((e) => {
    const edge = e as Record<string, unknown>;
    return {
      start: str(edge.from ?? edge.start ?? edge.id1 ?? edge.left),
      end: str(edge.to ?? edge.end ?? edge.id2 ?? edge.right),
      label: str(edge.message ?? edge.label ?? edge.text ?? edge.title ?? edge.relation ?? ''),
    };
  });

  return { nodes, edges, note: 'read via generic diagram accessors' };
}

function readGraph(db: unknown): GraphRead | null {
  if (!db || typeof db !== 'object') return null;
  const rec = db as Record<string, unknown>;
  return readFlowchart(rec) ?? readGeneric(rec);
}

/** Mermaid reports "Parse error on line N:" / "Lexical error on line N.". */
function parseErrorDetail(message: string, source: string): ParseErrorDetail {
  const match = /(?:Parse|Lexical) error on line (\d+)/i.exec(message);
  if (!match) return { message, line: null, lineText: null };

  const line = Number.parseInt(match[1], 10);
  const lines = source.split('\n');
  const lineText = line >= 1 && line <= lines.length ? lines[line - 1] : null;
  return { message, line, lineText };
}

function unavailable(note: string): DiagramCounts {
  return { nodes: 0, edges: 0, source: 'unavailable', note };
}

/**
 * Parse AND render a Mermaid source headlessly.
 *
 * Both stages run against real Mermaid: `getDiagramFromText` drives the actual jison
 * parser (and hands back the populated diagram DB), then `mermaid.render` builds real
 * SVG. A diagram is only reported as ok when both stages pass. Error text is captured
 * verbatim — never summarised, never replaced with a friendly string.
 */
export async function validateMermaid(source: string): Promise<ValidationResult> {
  return withMermaidLock(async () => {
    const mermaid = await ensureMermaid();
    const mermaidAPI = mermaid.mermaidAPI as unknown as {
      getDiagramFromText: (text: string) => Promise<{ type?: string; db?: unknown }>;
    };

    let diagramType: string | null = null;
    let graph: GraphRead | null = null;
    let parseError: ParseErrorDetail | null = null;

    try {
      const diagram = await mermaidAPI.getDiagramFromText(source);
      diagramType = typeof diagram?.type === 'string' ? diagram.type : null;
      graph = readGraph(diagram?.db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parseError = parseErrorDetail(message, source);
    }

    if (parseError) {
      return {
        diagramType,
        parseOk: false,
        parseError,
        renderOk: false,
        renderError: null,
        svg: null,
        counts: unavailable('diagram did not parse'),
        nodeLabels: [],
        edgeLabels: [],
      };
    }

    const counts: DiagramCounts = graph
      ? { nodes: graph.nodes.length, edges: graph.edges.length, source: 'parsed', note: graph.note }
      : unavailable(`no vertex/edge accessor for diagram type ${diagramType ?? 'unknown'}`);

    // Stage 2: actually render. A parse pass alone is not proof the diagram draws.
    const renderId = `schematic-${Math.random().toString(36).slice(2, 10)}`;
    let svg: string | null = null;
    let renderError: string | null = null;
    try {
      const out = await mermaid.render(renderId, source);
      svg = out.svg;
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err);
    } finally {
      // Mermaid leaves its measuring node behind when it throws.
      try {
        const doc = (globalThis as { document?: Document }).document;
        doc?.getElementById(renderId)?.remove();
        doc?.getElementById(`d${renderId}`)?.remove();
      } catch {
        /* cleanup is best-effort */
      }
    }

    return {
      diagramType,
      parseOk: true,
      parseError: null,
      renderOk: renderError === null,
      renderError,
      svg,
      counts,
      nodeLabels: graph?.nodes.map((n) => n.label).filter((l) => l.trim().length > 0) ?? [],
      edgeLabels: graph?.edges.map((e) => e.label).filter((l) => l.trim().length > 0) ?? [],
    };
  });
}