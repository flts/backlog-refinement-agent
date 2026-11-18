import { useState } from 'react';
import type { Thread } from '../agent';

export const sessionTitle = (thread?: Thread) => thread?.title?.trim() || 'New session';

export interface SessionTitleProps {
  /** The active thread; without one (before the first message) the title is "New session" and cannot be renamed. */
  thread?: Thread;
  disabled?: boolean;
  onRename: (threadId: string, title: string) => Promise<unknown>;
}

/** Title of the active session in the chat header. It follows the thread (for example after `set_session_title`) and renames inline. */
export function SessionTitle({ thread, disabled = false, onRename }: SessionTitleProps) {
  const [draft, setDraft] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const title = sessionTitle(thread);

  if (draft === undefined || !thread) {
    return (
      <div className="session-title">
        <h3 className="session-title-text" title={title}>{title}</h3>
        {thread && <button type="button" className="icon-button" aria-label="Rename session" title="Rename" disabled={disabled} onClick={() => { setError(false); setDraft(thread.title ?? ''); }}><span aria-hidden="true">✎</span></button>}
      </div>
    );
  }

  async function save() {
    const next = draft!.trim();
    if (!next || !thread) return;
    if (next === thread.title) { setDraft(undefined); return; }
    setPending(true);
    setError(false);
    try { await onRename(thread.id, next); setDraft(undefined); } catch { setError(true); } finally { setPending(false); }
  }

  return (
    <form className="session-title session-title-edit" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setDraft(undefined); } }}>
      <input autoFocus aria-label="Session name" value={draft} maxLength={120} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className="button button-primary button-small" disabled={pending || !draft.trim()}>Save</button>
      <button type="button" className="button button-secondary button-small" onClick={() => setDraft(undefined)}>Cancel</button>
      {error && <span className="thread-error" role="alert">Could not rename the session.</span>}
    </form>
  );
}
