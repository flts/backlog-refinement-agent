import { useMemo } from 'react';
import { collapseUnchanged, diffLines, hasChanges } from './lineDiff';

const marker = { add: '+', remove: '−', same: ' ' } as const;
const spoken = { add: 'Added: ', remove: 'Removed: ', same: '' } as const;

/** Unified line diff. Changes are conveyed by a marker and hidden text, never by colour alone. */
export function DiffView({ id, before, after, beforeLabel, afterLabel }: { id?: string; before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const rows = useMemo(() => collapseUnchanged(lines), [lines]);
  const title = `Changes from ${beforeLabel} to ${afterLabel}`;
  if (!hasChanges(lines)) return <p id={id} className="diff-empty" role="status">{afterLabel} is identical to {beforeLabel}.</p>;
  return <div id={id} className="diff-view" role="group" aria-label={title}>
    <p className="diff-legend"><span className="diff-key diff-key-remove">− {beforeLabel}</span> <span className="diff-key diff-key-add">+ {afterLabel}</span></p>
    <div className="diff-lines">
      {rows.map((row, index) => row.kind === 'skip'
        ? <div key={index} className="diff-line diff-skip">{row.count} unchanged {row.count === 1 ? 'line' : 'lines'}</div>
        : <div key={index} className={`diff-line diff-${row.kind}`}>
          <span className="sr-only">{spoken[row.kind]}</span><span className="diff-marker" aria-hidden="true">{marker[row.kind]}</span>
          <span className="diff-text">{row.text || ' '}</span>
        </div>)}
    </div>
  </div>;
}
