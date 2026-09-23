import type { ChecklistItem } from '../types';

interface Props {
  a: ChecklistItem[];
  b: ChecklistItem[];
  aLabel: string;
  bLabel: string;
}

function Tick({ item, label }: { item: ChecklistItem | undefined; label: string }) {
  if (!item) {
    return <span className="tick-cell muted">—</span>;
  }

  if (!item.present) {
    return (
      <span className="tick-cell" title={`${label}: no label matched any of the ${item.concept} keywords`}>
        <span className="dot hollow" aria-hidden="true" />
        <span className="tick-text absent">
          not mentioned
          {item.matchedLabel === null && (
            <small className="muted"> — no label in this diagram matched</small>
          )}
        </span>
      </span>
    );
  }

  return (
    <span
      className="tick-cell"
      title={
        `matched /${item.matchedTerm}/ in a ${item.matchedIn} label` +
        (item.sourceText ? `\nsource line ${item.sourceLine}: ${item.sourceText}` : '')
      }
    >
      <span className="dot filled" aria-hidden="true" />
      <span className="tick-text present">
        {item.matchedLabel}
        <small className="muted"> ({item.matchedIn} label)</small>
        {item.sourceLine !== null && (
          <small className="muted source-ref">
            line {item.sourceLine}
            {item.sourceText && <code className="source-quote">{item.sourceText}</code>}
          </small>
        )}
      </span>
    </span>
  );
}

export default function ChecklistPanel({ a, b, aLabel, bLabel }: Props) {
  const byConcept = (items: ChecklistItem[]) =>
    new Map(items.map((i) => [i.concept, i]));

  const ma = byConcept(a);
  const mb = byConcept(b);
  const concepts = a.length > 0 ? a.map((i) => i.concept) : b.map((i) => i.concept);

  const scoreA = a.filter((i) => i.present).length;
  const scoreB = b.filter((i) => i.present).length;

  return (
    <section className="checklist-panel">
      <header className="checklist-head">
        <h2>Did the model remember it?</h2>
        <p className="muted">
          Every tick is backed by a label that is literally present in that diagram's source. The
          matched label is printed beside the tick, so nothing here is a score you have to trust.
        </p>
      </header>

      <div className="checklist-grid">
        <div className="checklist-row header-row">
          <span className="concept-cell">Concept</span>
          <span className="slot-head accent-a">
            A · <strong>{aLabel}</strong> <em>{scoreA}/{concepts.length}</em>
          </span>
          <span className="slot-head accent-b">
            B · <strong>{bLabel}</strong> <em>{scoreB}/{concepts.length}</em>
          </span>
        </div>

        {concepts.map((concept) => {
          const itemA = ma.get(concept);
          const itemB = mb.get(concept);
          const differs = (itemA?.present ?? false) !== (itemB?.present ?? false);
          return (
            <div key={concept} className={`checklist-row ${differs ? 'differs' : ''}`}>
              <span className="concept-cell">
                {concept}
                {differs && <span className="pill split">split</span>}
              </span>
              <Tick item={itemA} label={`slot A (${aLabel})`} />
              <Tick item={itemB} label={`slot B (${bLabel})`} />
            </div>
          );
        })}
      </div>

      <footer className="checklist-legend">
        <span>
          <span className="dot filled" aria-hidden="true" /> mentioned — matched label shown
        </span>
        <span>
          <span className="dot hollow" aria-hidden="true" /> not mentioned — no label matched
        </span>
      </footer>
    </section>
  );
}