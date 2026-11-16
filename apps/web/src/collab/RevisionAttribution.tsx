import type { Revision } from '../api';
import { formatTime } from '../app/labels';

export const originText: Record<Revision['origin'], string> = { manual: '', agent: 'via agent', restore: 'restored a version' };

/** "Anna via agent", "Frank", "Anna restored a version". */
export function attributionText(revision: Pick<Revision, 'actor' | 'origin'>, nameOf: (email: string) => string): string {
  return [nameOf(revision.actor), originText[revision.origin]].filter(Boolean).join(' ');
}

/** The author and origin of the latest saved versions, newest first. */
export function RevisionAttribution({ revisions, nameOf, limit = 5 }: { revisions: Revision[]; nameOf: (email: string) => string; limit?: number }) {
  if (!revisions.length) return null;
  return <details className="revision-attribution">
    <summary>Who changed this</summary>
    <ol aria-label="Latest versions, newest first">
      {revisions.slice(0, limit).map((revision) => <li key={revision.id}>
        <span className="revision-version">v{revision.version}</span>
        <span>{attributionText(revision, nameOf)}</span>
        {revision.label && <span className="revision-label">{revision.label}</span>}
        <time dateTime={revision.createdAt}>{formatTime(revision.createdAt)}</time>
      </li>)}
    </ol>
  </details>;
}
