import type { ChecklistItem } from './types.js';

/**
 * The checklist is the viral payload, so every tick has to survive scrutiny.
 *
 * Matching runs against the *parsed* node and edge labels — the same strings Mermaid
 * read — and every hit reports the literal label it matched plus the regex term that
 * fired. Nothing is scored, nothing is inferred: if the UI shows a tick, the matched
 * label is printed next to it and that exact string is findable in the diagram source.
 *
 * Only when a diagram failed to parse (so there are no labels to read) do we fall back
 * to scanning raw source lines, and those hits are tagged `matchedIn: 'source'` so the
 * weaker evidence is visible rather than disguised.
 */

export interface Concept {
  concept: string;
  /** Short noun used in the shareable headline, e.g. "retries". */
  headline: string;
  terms: RegExp[];
}

/**
 * Deliberate precision choices in these patterns:
 *  - `auth(?!or)` so "Authorization" counts but "Author" does not.
 *  - `logs?\b` so "Logs" counts but "Login" does not.
 *  - `\bLB\b`, `\bDLQ\b` are case-sensitive because the lowercase forms collide with
 *    ordinary words.
 */
export const CONCEPTS: Concept[] = [
  {
    concept: 'Cache',
    headline: 'caching',
    terms: [/\bcach(?:e|es|ed|ing)\b/i, /\bredis\b/i, /\bmemcach\w*/i, /\bvarnish\b/i, /\bkeydb\b/i],
  },
  {
    concept: 'Queue',
    headline: 'a queue',
    terms: [
      /\bqueue\w*/i, /\bkafka\b/i, /\bsqs\b/i, /\brabbit\w*/i, /\bpub\/?sub\b/i,
      /\bbroker\w*/i, /\bnats\b/i, /\bmessage bus\b/i, /\bkinesis\b/i, /\bpulsar\b/i,
    ],
  },
  {
    concept: 'Load balancer',
    headline: 'a load balancer',
    terms: [
      /\bload\s?balanc\w*/i, /\bLB\b/, /\bnginx\b/i, /\bhaproxy\b/i, /\benvoy\b/i,
      /\bALB\b/, /\bELB\b/, /\bingress\b/i, /\breverse proxy\b/i,
    ],
  },
  {
    concept: 'Auth',
    headline: 'auth',
    terms: [
      /\bauth(?!or)\w*/i, /\boauth\w*/i, /\bjwt\b/i, /\blogin\b/i, /\bsso\b/i,
      /\bidentity\b/i, /\bapi[-\s]?key\w*/i, /\bcredential\w*/i, /\bsession\b/i,
      /\baccess[-\s]?token\w*/i,
    ],
  },
  {
    concept: 'Retry',
    headline: 'retries',
    terms: [/\bretr(?:y|ies|ying)\b/i, /\bback[-\s]?off\b/i, /\bredeliver\w*/i, /\bre-?attempt\w*/i],
  },
  {
    concept: 'Idempotency',
    headline: 'idempotency',
    terms: [
      /\bidempot\w*/i, /\bexactly[-\s]once\b/i, /\bdedup\w*/i, /\bdeduplicat\w*/i,
      /\bat[-\s]most[-\s]once\b/i, /\bunique[-\s]?key\w*/i,
    ],
  },
  {
    concept: 'Observability / metrics',
    headline: 'observability',
    terms: [
      /\bobserv\w*/i, /\bmetric\w*/i, /\bmonitor\w*/i, /\blogs?\b/i, /\blogging\b/i,
      /\btrac(?:e|es|ing)\b/i, /\bprometheus\b/i, /\bgrafana\b/i, /\bdatadog\b/i,
      /\btelemetry\b/i, /\bdashboard\w*/i, /\balert\w*/i, /\botel\b/i,
      /\bopentelemetry\b/i, /\bsentry\b/i, /\bcloudwatch\b/i, /\bapm\b/i,
    ],
  },
  {
    concept: 'Rate limit',
    headline: 'rate limiting',
    terms: [/\brate[-\s]?limit\w*/i, /\bthrottl\w*/i, /\bquota\w*/i, /\btoken bucket\b/i, /\bleaky bucket\b/i],
  },
  {
    concept: 'Database',
    headline: 'a database',
    terms: [
      /\bdatabase\w*/i, /\bdb\b/i, /\bpostgres\w*/i, /\bmysql\b/i, /\bsql\b/i,
      /\bmongo\w*/i, /\bdynamo\w*/i, /\bcassandra\b/i, /\bclickhouse\b/i, /\bsqlite\b/i,
      /\bstorage\b/i, /\bwarehouse\b/i, /\bs3\b/i, /\bbigtable\b/i,
    ],
  },
  {
    concept: 'Circuit breaker',
    headline: 'a circuit breaker',
    terms: [/\bcircuit[-\s]?break\w*/i, /\bbreaker\b/i, /\bbulkhead\b/i, /\bfail[-\s]?fast\b/i],
  },
  {
    concept: 'Dead-letter',
    headline: 'a dead-letter queue',
    terms: [/\bdead[-\s]?letter\w*/i, /\bDLQ\b/, /\bpoison\b/i, /\bparking lot\b/i],
  },
  {
    concept: 'CDN',
    headline: 'a CDN',
    terms: [/\bCDN\b/i, /\bcloudfront\b/i, /\bakamai\b/i, /\bcloudflare\b/i, /\bedge cach\w*/i, /\bfastly\b/i],
  },
];

export interface ChecklistInput {
  nodeLabels: string[];
  edgeLabels: string[];
  /** Raw diagram source; only scanned when the diagram produced no labels. */
  source: string;
}

interface Hit {
  label: string;
  term: string;
  where: 'node' | 'edge' | 'source';
}

function firstHit(concept: Concept, values: string[], where: 'node' | 'edge' | 'source'): Hit | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    for (const term of concept.terms) {
      if (term.test(trimmed)) {
        return { label: trimmed, term: term.source, where };
      }
    }
  }
  return null;
}

/** Source fallback: report the trimmed line that matched, so it is quotable. */
function sourceHit(concept: Concept, source: string): Hit | null {
  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);
  return firstHit(concept, lines, 'source');
}

/**
 * Mermaid rewrites label text while parsing: `<br/>` in the source comes back as `<br>`,
 * and runs of whitespace are collapsed. So a parsed label is not always a byte-for-byte
 * substring of the diagram source.
 *
 * We keep the matched label exactly as Mermaid read it — that is the honest value — and
 * separately locate the source line it came from, comparing under the same
 * normalisation. That is what makes the tick auditable rather than merely asserted.
 */
function normalizeForSearch(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findSourceLine(
  source: string,
  label: string,
): { line: number; text: string } | null {
  const target = normalizeForSearch(label);
  if (!target) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (normalizeForSearch(lines[i]).includes(target)) {
      return { line: i + 1, text: lines[i].trim() };
    }
  }
  return null;
}

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const hasLabels = input.nodeLabels.length > 0 || input.edgeLabels.length > 0;

  return CONCEPTS.map((concept) => {
    // Parsed labels are the strong evidence, so they are always tried first.
    const hit =
      firstHit(concept, input.nodeLabels, 'node') ??
      firstHit(concept, input.edgeLabels, 'edge') ??
      (hasLabels ? null : sourceHit(concept, input.source));

    const located = hit ? findSourceLine(input.source, hit.label) : null;

    return {
      concept: concept.concept,
      present: hit !== null,
      matchedLabel: hit?.label ?? null,
      matchedTerm: hit?.term ?? null,
      matchedIn: hit?.where ?? null,
      sourceLine: located?.line ?? null,
      sourceText: located?.text ?? null,
    };
  });
}

/** Concepts present in one diagram and absent from the other — the shareable line. */
export function conceptDiff(a: ChecklistItem[], b: ChecklistItem[]): Array<{ concept: string; a: boolean; b: boolean }> {
  return a.map((item, i) => ({ concept: item.concept, a: item.present, b: b[i]?.present ?? false }));
}

export function headlineFor(
  onlyB: string[],
  onlyA: string[],
  summary: Array<{ concept: string; a: boolean; b: boolean }>,
): string {
  const headlineOf = (concept: string) => CONCEPTS.find((c) => c.concept === concept)?.headline ?? concept;

  const bExtra = summary.filter((s) => s.b && !s.a).map((s) => headlineOf(s.concept));
  const aExtra = summary.filter((s) => s.a && !s.b).map((s) => headlineOf(s.concept));

  if (bExtra.length > 0 && aExtra.length === 0) {
    return `B planned for ${list(bExtra)}; A did not.`;
  }
  if (aExtra.length > 0 && bExtra.length === 0) {
    return `A planned for ${list(aExtra)}; B did not.`;
  }
  if (bExtra.length > 0 && aExtra.length > 0) {
    return `B added ${list(bExtra)}; A added ${list(aExtra)}.`;
  }
  if (onlyA.length > 0 || onlyB.length > 0) {
    return `Same concepts on both sides; ${onlyB.length} label(s) unique to B, ${onlyA.length} unique to A.`;
  }
  return 'Both diagrams cover the same concepts.';
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}