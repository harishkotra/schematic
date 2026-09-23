import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChecklist, CONCEPTS, findSourceLine } from '../src/checklist.js';
import { validateMermaid } from '../src/validate.js';

const byConcept = (items: ReturnType<typeof buildChecklist>) =>
  Object.fromEntries(items.map((i) => [i.concept, i]));

test('every concept is reported exactly once, in a stable order', () => {
  const items = buildChecklist({ nodeLabels: [], edgeLabels: [], source: '' });
  assert.equal(items.length, CONCEPTS.length);
  assert.deepEqual(items.map((i) => i.concept), [
    'Cache', 'Queue', 'Load balancer', 'Auth', 'Retry', 'Idempotency',
    'Observability / metrics', 'Rate limit', 'Database', 'Circuit breaker',
    'Dead-letter', 'CDN',
  ]);
  assert.ok(items.every((i) => i.present === false && i.matchedLabel === null));
});

test('a tick carries the literal label it matched, from parsed node labels', () => {
  const items = byConcept(buildChecklist({
    nodeLabels: ['Client', 'Redis Cache', 'Worker'],
    edgeLabels: [],
    source: '',
  }));
  assert.equal(items['Cache'].present, true);
  assert.equal(items['Cache'].matchedLabel, 'Redis Cache');
  assert.equal(items['Cache'].matchedIn, 'node');
  assert.equal(items['Cache'].matchedTerm, '\\bcach(?:e|es|ed|ing)\\b');
});

test('edge labels are matched too, and tagged as edges', () => {
  const items = byConcept(buildChecklist({
    nodeLabels: ['Worker', 'Queue'],
    edgeLabels: ['retry with exponential backoff'],
    source: '',
  }));
  assert.equal(items.Retry.present, true);
  assert.equal(items.Retry.matchedLabel, 'retry with exponential backoff');
  assert.equal(items.Retry.matchedIn, 'edge');
});

test('node labels win over edge labels when both match', () => {
  const items = byConcept(buildChecklist({
    nodeLabels: ['Retry Service'],
    edgeLabels: ['retry'],
    source: '',
  }));
  assert.equal(items.Retry.matchedLabel, 'Retry Service');
  assert.equal(items.Retry.matchedIn, 'node');
});

test('raw source is only scanned when the diagram produced no labels', () => {
  const withLabels = byConcept(buildChecklist({
    nodeLabels: ['Client'],
    edgeLabels: [],
    source: 'flowchart TD\n  Client --> RedisCache[(Redis Cache)]',
  }));
  assert.equal(withLabels.Cache.present, false, 'source text must not be used when labels exist');

  const withoutLabels = byConcept(buildChecklist({
    nodeLabels: [],
    edgeLabels: [],
    source: 'flowchart TD\n  A --> RedisCache[(Redis Cache)]',
  }));
  assert.equal(withoutLabels.Cache.present, true);
  assert.equal(withoutLabels.Cache.matchedIn, 'source');
  assert.match(withoutLabels.Cache.matchedLabel ?? '', /Redis Cache/);
});

test('does not tick Auth on the word "Author"', () => {
  const items = byConcept(buildChecklist({ nodeLabels: ['Author Service'], edgeLabels: [], source: '' }));
  assert.equal(items.Auth.present, false);
});

test('does not tick Observability on the word "Login"', () => {
  const items = byConcept(buildChecklist({ nodeLabels: ['Login Gateway'], edgeLabels: [], source: '' }));
  assert.equal(items['Observability / metrics'].present, false);
  assert.equal(items.Auth.present, true, 'but Login is genuine auth evidence');
});

test('ticks the twelve concepts on a diagram that has them all', () => {
  const labels = [
    'CDN', 'Load Balancer', 'Auth Service', 'Rate Limiter', 'Redis Cache',
    'Kafka Queue', 'Postgres Database', 'Circuit Breaker', 'Dead Letter Queue',
    'Prometheus Metrics', 'Idempotency Key Store',
  ];
  const items = byConcept(buildChecklist({ nodeLabels: labels, edgeLabels: ['retry'], source: '' }));
  const missing = items && Object.values(items).filter((i) => !i.present).map((i) => i.concept);
  assert.deepEqual(missing, []);
});

/**
 * The acceptance criterion in its strongest form: every ticked concept must be
 * findable in the diagram source by searching for the reported matched label.
 */
test('every tick is backed by a label that really appears in the source', async () => {
  const source = `flowchart TD
  Client[Client] --> LB[Load Balancer]
  LB --> API[API Server]
  API --> Auth[Auth Service]
  API --> Cache[(Redis Cache)]
  API --> DB[(Postgres Database)]
  API -. retry with backoff .-> Queue[[Kafka Queue]]
  API --> Metrics[Prometheus Metrics]`;

  const v = await validateMermaid(source);
  assert.equal(v.parseOk, true);
  const items = buildChecklist({ nodeLabels: v.nodeLabels, edgeLabels: v.edgeLabels, source });

  const ticked = items.filter((i) => i.present);
  assert.ok(ticked.length >= 6, `expected several ticks, got ${ticked.length}`);
  for (const item of ticked) {
    assert.ok(item.matchedLabel, `${item.concept} ticked with no label`);
    assert.ok(
      source.includes(item.matchedLabel),
      `${item.concept} claims label ${JSON.stringify(item.matchedLabel)} which is not in the source`,
    );
    // And the tick cites the source line it came from.
    assert.ok(item.sourceLine !== null, `${item.concept} has no source line`);
    assert.ok(source.split('\n')[item.sourceLine! - 1].includes(item.matchedLabel!));
  }
  // And the honest misses stay misses.
  assert.equal(items.find((i) => i.concept === 'CDN')?.present, false);
  assert.equal(items.find((i) => i.concept === 'Dead-letter')?.present, false);
});

/**
 * Mermaid normalises label text as it parses — `<br/>` becomes `<br>` — so a parsed
 * label is not always a byte-for-byte substring of the source. That must not break the
 * audit, or a tick would be unverifiable through no fault of the model.
 */
test('a label Mermaid normalised is still located in the source', async () => {
  const source = `flowchart TD
  RC[(Read Cache<br/>Short to Long URL)]
  RC --> API[API Server]`;

  const v = await validateMermaid(source);
  assert.equal(v.parseOk, true);
  const items = buildChecklist({ nodeLabels: v.nodeLabels, edgeLabels: v.edgeLabels, source });

  const cache = items.find((i) => i.concept === 'Cache')!;
  assert.equal(cache.present, true);
  // Mermaid's own reading, with the tag normalised.
  assert.equal(cache.matchedLabel, 'Read Cache<br>Short to Long URL');
  assert.ok(!source.includes(cache.matchedLabel!), 'precondition: raw source differs');
  // …and yet the tick still points at the real source line.
  assert.equal(cache.sourceLine, 2);
  assert.equal(cache.sourceText, 'RC[(Read Cache<br/>Short to Long URL)]');
  assert.ok(cache.sourceText!.includes('Read Cache'));
});

test('findSourceLine is exact about whitespace and returns null when absent', () => {
  const source = 'flowchart TD\n  A[Redis   Cache]\n  B[X]';
  assert.deepEqual(findSourceLine(source, 'Redis Cache'), { line: 2, text: 'A[Redis   Cache]' });
  assert.equal(findSourceLine(source, 'Nonexistent Service'), null);
  assert.equal(findSourceLine(source, ''), null);
});
