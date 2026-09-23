import type { ExtractionPath } from './types.js';

export interface Extraction {
  source: string | null;
  path: ExtractionPath;
  note: string | null;
}

/** Diagram keywords Mermaid accepts as an opening token. */
const DIAGRAM_KEYWORDS = [
  'flowchart', 'graph', 'sequenceDiagram', 'C4Context', 'C4Container', 'C4Component',
  'C4Dynamic', 'C4Deployment', 'erDiagram', 'classDiagram', 'stateDiagram',
  'stateDiagram-v2', 'journey', 'gantt', 'pie', 'mindmap', 'timeline', 'gitGraph',
  'quadrantChart', 'xychart-beta', 'block-beta', 'sankey-beta', 'architecture-beta',
];

const OPENING_LINE = new RegExp(
  `^\\s*(?:${DIAGRAM_KEYWORDS.map((k) => k.replace(/[-]/g, '\\-')).join('|')})\\b`,
  'i',
);

interface Fence {
  info: string;
  body: string;
}

function findFences(reply: string): Fence[] {
  const fences: Fence[] = [];
  const re = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(reply)) !== null) {
    fences.push({ info: match[1].trim(), body: match[2] });
  }
  return fences;
}

/** A model that writes "```mermaid" on one line sometimes repeats the word inside. */
function stripRedundantLanguageLine(body: string): string {
  return body.replace(/^\s*mermaid\s*\r?\n/i, '');
}

function clean(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function startsWithDiagramKeyword(text: string): boolean {
  return OPENING_LINE.test(text);
}

/**
 * Pull Mermaid source out of a model reply.
 *
 * Order of preference, recorded in `path` so the UI can state which route was taken:
 *   1. a ```mermaid fence            -> 'mermaid-fence'
 *   2. any fence whose body opens with a diagram keyword -> 'plain-fence'
 *   3. a reply that itself opens with a diagram keyword  -> 'bare'
 *   4. the first keyword-opening line found mid-reply    -> 'bare-inline'
 *
 * Nothing is repaired or rewritten. If the model produced broken Mermaid we hand the
 * broken text to the real parser and report what the parser said.
 */
export function extractMermaid(reply: string): Extraction {
  if (!reply || !reply.trim()) {
    return { source: null, path: 'none', note: 'reply was empty' };
  }

  const fences = findFences(reply);

  const mermaidFence = fences.find((f) => /^mermaid\b/i.test(f.info));
  if (mermaidFence) {
    const body = clean(stripRedundantLanguageLine(mermaidFence.body));
    if (body) return { source: body, path: 'mermaid-fence', note: null };
  }

  const keywordFence = fences.find((f) => startsWithDiagramKeyword(f.body.trim()));
  if (keywordFence) {
    const body = clean(stripRedundantLanguageLine(keywordFence.body));
    if (body) {
      return { source: body, path: 'plain-fence', note: 'fence had no "mermaid" language tag' };
    }
  }

  const trimmed = reply.trim();
  if (startsWithDiagramKeyword(trimmed)) {
    return { source: clean(trimmed), path: 'bare', note: 'reply was not fenced' };
  }

  const lines = reply.split('\n');
  const startIndex = lines.findIndex((line) => startsWithDiagramKeyword(line));
  if (startIndex >= 0) {
    const body = clean(lines.slice(startIndex).join('\n'));
    if (body) {
      return {
        source: body,
        path: 'bare-inline',
        note: `diagram began at line ${startIndex + 1} with prose before it`,
      };
    }
  }

  const info = fences.length > 0
    ? `found ${fences.length} fence(s) but none contained a diagram: ${fences.map((f) => f.info || '(untagged)').join(', ')}`
    : 'no ```mermaid fence and no line starting with a Mermaid diagram keyword';
  return { source: null, path: 'none', note: info };
}