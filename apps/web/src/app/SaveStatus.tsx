import type { SaveStatus as Status } from '../collab';

const text: Record<Status, string> = { saved: 'Saved', saving: 'Saving…', conflict: 'Conflict', error: 'Not saved' };

/**
 * Autosave indicator: Saving… / Saved / Conflict (a button that reopens the conflict dialog) / Not saved. Only a failed save
 * is announced (assertively); saving/saved would chatter on every keystroke and a conflict opens its own dialog.
 */
export function SaveStatus({ status, onResolve }: { status: Status; onResolve: () => void }) {
  return <span className={`local-badge save-status save-${status}`}>
    <span aria-hidden="true" />
    {status === 'conflict' ? <button type="button" className="save-resolve" onClick={onResolve}>Conflict – resolve</button> : text[status]}
    <span className="sr-only" aria-live="assertive" aria-atomic="true">{status === 'error' ? 'Your last change could not be saved.' : ''}</span>
  </span>;
}
