import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMermaid } from '../src/validate.js';

const GOOD = `flowchart TD
  Client[Client] --> LB[Load Balancer]
  LB --> API[API Server]
  API --> Cache[(Redis Cache)]
  API --> Queue[[Kafka Queue]]
  Queue --> Worker[Worker]
  Worker --> DB[(Postgres Database)]
  Worker -. retry with backoff .-> Queue`;

test('parses and renders a real flowchart, and counts nodes/edges from the parsed graph', async () => {
  const v = await validateMermaid(GOOD);
  assert.equal(v.parseOk, true, v.parseError?.message);
  assert.equal(v.renderOk, true, v.renderError ?? '');
  assert.equal(v.diagramType, 'flowchart-v2');
  // 7 distinct nodes, 7 edges — read from Mermaid's own diagram DB.
  assert.equal(v.counts.source, 'parsed');
  assert.equal(v.counts.nodes, 7);
  assert.equal(v.counts.edges, 7);
  assert.ok(v.svg && v.svg.includes('<svg'), 'renderer must return SVG');
});

test('node labels come from the parsed graph, not from the raw text', async () => {
  const v = await validateMermaid(GOOD);
  assert.deepEqual(v.nodeLabels.sort(), [
    'API Server', 'Client', 'Kafka Queue', 'Load Balancer',
    'Postgres Database', 'Redis Cache', 'Worker',
  ].sort());
  assert.ok(v.edgeLabels.includes('retry with backoff'));
});

test('counts differ from a naive line count — proof they come from the parse', async () => {
  // One line declares two nodes and one edge; a line counter would say 1/0.
  const v = await validateMermaid('flowchart TD\n  A[Alpha] --> B[Beta]');
  assert.equal(v.counts.nodes, 2);
  assert.equal(v.counts.edges, 1);
});

test('reports a verbatim parse error with the offending line', async () => {
  const broken = `flowchart TD
  A[Client] --> B[API]
  B -->> C[Broken]`;
  const v = await validateMermaid(broken);
  assert.equal(v.parseOk, false);
  assert.ok(v.parseError, 'expected a parse error');
  assert.match(v.parseError.message, /Parse error on line 3/);
  assert.equal(v.parseError.line, 3);
  assert.equal(v.parseError.lineText, '  B -->> C[Broken]');
  assert.equal(v.svg, null);
  assert.equal(v.counts.source, 'unavailable');
});

test('a parse error is never silently repaired', async () => {
  const v = await validateMermaid('flowchart TD\n  A --> B\n  C -> D');
  assert.equal(v.parseOk, false);
  assert.ok((v.parseError?.message.length ?? 0) > 20);
});

test('handles a diagram type with no flowchart DB without inventing counts', async () => {
  const v = await validateMermaid('sequenceDiagram\n  Alice->>Bob: Hello');
  assert.equal(v.parseOk, true, v.parseError?.message);
  assert.equal(v.diagramType, 'sequence');
  // Whatever it finds must be honestly labelled.
  if (v.counts.source === 'unavailable') assert.ok(v.counts.note);
});

test('validates concurrently without cross-contaminating state', async () => {
  const [a, b, c] = await Promise.all([
    validateMermaid(GOOD),
    validateMermaid('flowchart LR\n  X[Xray] --> Y[Yankee]'),
    validateMermaid('flowchart TD\n  P[Papa] --> Q[Quebec]\n  Q --> R[Romeo]'),
  ]);
  assert.equal(a.counts.nodes, 7);
  assert.equal(b.counts.nodes, 2);
  assert.equal(c.counts.nodes, 3);
  assert.ok(!b.nodeLabels.includes('Client'));
});