import type {
  ChecklistItem,
  DiagramCounts,
  ModelResult,
  ParseErrorDetail,
  ValidationResponse,
} from '../types';

/**
 * What one diagram panel displays. Built either from a full run result or from a
 * re-validation of hand-edited source, so the two paths share one renderer.
 */
export interface PanelState {
  source: string;
  svg: string | null;
  /** Verbatim error from the browser's own Mermaid render, if it failed. */
  clientError: string | null;
  parseOk: boolean;
  parseError: ParseErrorDetail | null;
  renderOk: boolean;
  renderError: string | null;
  counts: DiagramCounts;
  byteCount: number;
  nodeLabels: string[];
  edgeLabels: string[];
  checklist: ChecklistItem[];
  /** True once the source has been edited away from the model's output. */
  edited: boolean;
}

export function panelFromResult(result: ModelResult): PanelState {
  return {
    source: result.mermaid ?? '',
    svg: null,
    clientError: null,
    parseOk: result.parseOk,
    parseError: result.parseError,
    renderOk: result.ok,
    renderError: result.errorKind === 'parse' ? result.error : null,
    counts: result.counts,
    byteCount: result.byteCount,
    nodeLabels: result.nodeLabels,
    edgeLabels: result.edgeLabels,
    checklist: result.checklist,
    edited: false,
  };
}

export function panelFromValidation(
  validation: ValidationResponse,
  source: string,
  svg: string | null,
  clientError: string | null,
  edited: boolean,
): PanelState {
  return {
    source,
    svg,
    clientError,
    parseOk: validation.parseOk,
    parseError: validation.parseError,
    renderOk: validation.renderOk,
    renderError: validation.renderError,
    counts: validation.counts,
    byteCount: validation.byteCount,
    nodeLabels: validation.nodeLabels,
    edgeLabels: validation.edgeLabels,
    checklist: validation.checklist,
    edited,
  };
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s/.]/gu, '')
    .trim();
}

/**
 * Set difference of node labels — the most shareable line in the app.
 * A pure function of the parsed labels, so it stays live while editing.
 */
export function diffNodeLabels(a: string[], b: string[]): { onlyInA: string[]; onlyInB: string[] } {
  const setOf = (labels: string[]) => {
    const map = new Map<string, string>();
    for (const label of labels) {
      if (label.trim().length < 2) continue;
      const key = normalizeLabel(label);
      if (key && !map.has(key)) map.set(key, label.trim());
    }
    return map;
  };
  const sa = setOf(a);
  const sb = setOf(b);
  return {
    onlyInA: [...sa.entries()].filter(([k]) => !sb.has(k)).map(([, v]) => v).sort(),
    onlyInB: [...sb.entries()].filter(([k]) => !sa.has(k)).map(([, v]) => v).sort(),
  };
}

/** Empty but well-formed panel, for a slot that never produced a diagram. */
export function emptyPanel(source = ''): PanelState {
  return {
    source,
    svg: null,
    clientError: null,
    parseOk: false,
    parseError: null,
    renderOk: false,
    renderError: null,
    counts: { nodes: 0, edges: 0, source: 'unavailable', note: 'no diagram' },
    byteCount: 0,
    nodeLabels: [],
    edgeLabels: [],
    checklist: [],
    edited: false,
  };
}