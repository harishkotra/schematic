interface Props {
  headline: string;
  onlyInA: string[];
  onlyInB: string[];
  aLabel: string;
  bLabel: string;
  stale: boolean;
}

function Chips({ labels, tone }: { labels: string[]; tone: 'a' | 'b' }) {
  if (labels.length === 0) {
    return <span className="muted">nothing unique</span>;
  }
  const shown = labels.slice(0, 14);
  return (
    <>
      {shown.map((label) => (
        <span key={label} className={`chip accent-${tone}`}>
          {label}
        </span>
      ))}
      {labels.length > shown.length && (
        <span className="chip more">+{labels.length - shown.length} more</span>
      )}
    </>
  );
}

export default function DiffStrip({ headline, onlyInA, onlyInB, aLabel, bLabel, stale }: Props) {
  return (
    <section className="diff-strip">
      <p className="headline">{headline}</p>
      {stale && (
        <p className="muted small">
          A panel has been edited by hand since the last run — the labels below are live, the
          sentence above describes the last run.
        </p>
      )}

      <div className="diff-columns">
        <div className="diff-column accent-a">
          <h3>
            Only in A <em>{aLabel}</em> <span className="count">{onlyInA.length}</span>
          </h3>
          <div className="chips">
            <Chips labels={onlyInA} tone="a" />
          </div>
        </div>
        <div className="diff-column accent-b">
          <h3>
            Only in B <em>{bLabel}</em> <span className="count">{onlyInB.length}</span>
          </h3>
          <div className="chips">
            <Chips labels={onlyInB} tone="b" />
          </div>
        </div>
      </div>
    </section>
  );
}