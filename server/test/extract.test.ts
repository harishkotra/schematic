import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMermaid } from '../src/extract.js';

test('prefers a ```mermaid fence', () => {
  const reply = 'Sure!\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nHope that helps.';
  const r = extractMermaid(reply);
  assert.equal(r.path, 'mermaid-fence');
  assert.equal(r.source, 'flowchart TD\n  A --> B');
});

test('accepts an untagged fence that opens with a diagram keyword', () => {
  const r = extractMermaid('```\nflowchart LR\n  X --> Y\n```');
  assert.equal(r.path, 'plain-fence');
  assert.equal(r.source, 'flowchart LR\n  X --> Y');
});

test('accepts a bare reply starting with flowchart', () => {
  const r = extractMermaid('flowchart TD\n  A --> B');
  assert.equal(r.path, 'bare');
});

test('accepts a reply starting with graph', () => {
  assert.equal(extractMermaid('graph TD\n A-->B').path, 'bare');
});

test('accepts a reply starting with sequenceDiagram', () => {
  assert.equal(extractMermaid('sequenceDiagram\n A->>B: hi').path, 'bare');
});

test('accepts a reply starting with C4', () => {
  assert.equal(extractMermaid('C4Context\n title x').path, 'bare');
});

test('recovers a diagram that begins mid-reply and records the line', () => {
  const reply = 'Here is the design you asked for.\n\nflowchart TD\n  A --> B\n';
  const r = extractMermaid(reply);
  assert.equal(r.path, 'bare-inline');
  assert.match(r.note ?? '', /line 3/);
  assert.equal(r.source, 'flowchart TD\n  A --> B');
});

test('tolerates the language word repeated inside the fence', () => {
  const r = extractMermaid('```mermaid\nmermaid\nflowchart TD\n A-->B\n```');
  assert.equal(r.source, 'flowchart TD\n A-->B');
});

test('reports none with a reason when there is no diagram', () => {
  const r = extractMermaid('I cannot help with that.');
  assert.equal(r.source, null);
  assert.equal(r.path, 'none');
  assert.match(r.note ?? '', /no ```mermaid fence/);
});

test('reports none for an empty reply', () => {
  const r = extractMermaid('   ');
  assert.equal(r.source, null);
  assert.match(r.note ?? '', /empty/);
});

test('does not repair broken source — it hands the parser what the model wrote', () => {
  const r = extractMermaid('```mermaid\nflowchart TD\n  A -->> B\n```');
  assert.equal(r.path, 'mermaid-fence');
  assert.match(r.source ?? '', /A -->> B/);
});