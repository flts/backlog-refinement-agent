import { DiffView } from '../settings/DiffView';
import { sectionDiff } from './proposal';
import type { SectionChange } from '../contracts';

/** Unified diff of one proposed section against the current document. Text equivalents ("Added:"/"Removed:") come from DiffView. */
export function SectionDiff({ document, change, id }: { document: string; change: Pick<SectionChange, 'heading' | 'markdown' | 'mode'>; id?: string }) {
  const { before, after, isNew } = sectionDiff(document, change);
  if (isNew) {
    const lines = after.split('\n');
    return (
      <div id={id} className="diff-view" role="group" aria-label={`New section ${change.heading}`}>
        <p className="diff-legend"><span className="diff-key diff-key-add">+ New section</span></p>
        <div className="diff-lines">
          {lines.map((line, index) => (
            <div key={index} className="diff-line diff-add"><span className="sr-only">Added: </span><span className="diff-marker" aria-hidden="true">+</span><span className="diff-text">{line || ' '}</span></div>
          ))}
        </div>
      </div>
    );
  }
  return <DiffView id={id} before={before} after={after} beforeLabel="current" afterLabel="proposed" />;
}
