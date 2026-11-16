import type { SaveStatus as Status } from '../collab';

const text: Record<Status, string> = { saved: 'Saved', saving: 'Saving…', conflict: 'Conflict', error: 'Not saved' };

/** Autosave indicator: Saving… / Saved / Conflict (a button that reopens the conflict dialog) / Not saved. */
export function SaveStatus({ status, onResolve }: { status: Status; onResolve: () => void }) {
  return <span className={`local-badge save-status save-${status}`} role="status">
    <span aria-hidden="true" />
    {status === 'conflict' ? <button type="button" className="save-resolve" onClick={onResolve}>Conflict – resolve</button> : text[status]}
  </span>;
}
