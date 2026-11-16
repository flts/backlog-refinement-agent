import { useEffect, useId, useRef, useState } from 'react';
import type { Thread, ThreadStatus } from '../agent';
import { relativeTime } from './time';

export interface ThreadPickerProps {
  /** The signed-in user's own threads for the item (the agent service scopes the list to the user). */
  threads: Thread[];
  activeThreadId?: string;
  /** Switching, creating, renaming and deleting are blocked while the agent works. */
  disabled?: boolean;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onRename: (threadId: string, title: string) => Promise<unknown>;
  onDelete: (threadId: string) => Promise<unknown>;
}

const badges: Partial<Record<ThreadStatus, string>> = { awaiting_input: 'Awaiting input', awaiting_review: 'Review', running: 'Running' };

export const threadTitle = (thread: Thread) => thread.title?.trim() || 'Untitled session';

/**
 * Session switcher: a disclosure button listing the user's sessions for the item (title, relative time, status badge)
 * with inline rename, delete with confirmation and a separate "New session" button. Sessions are private.
 */
export function ThreadPicker({ threads, activeThreadId, disabled = false, onSelect, onCreate, onRename, onDelete }: ThreadPickerProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const active = threads.find((thread) => thread.id === activeThreadId);

  function close(returnFocus: boolean) {
    setOpen(false);
    setRenaming(undefined);
    setConfirming(undefined);
    setError(undefined);
    if (returnFocus) trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  useEffect(() => { if (disabled) close(false); }, [disabled]);

  async function run(action: () => Promise<unknown>, failure: string, done: () => void) {
    setPending(true);
    setError(undefined);
    try { await action(); done(); } catch { setError(failure); } finally { setPending(false); }
  }

  const saveRename = () => {
    if (!renaming || !renaming.title.trim()) return;
    void run(() => onRename(renaming.id, renaming.title.trim()), 'Could not rename the session.', () => setRenaming(undefined));
  };

  return (
    <div className="thread-picker" ref={root} onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(true); } }}>
      <button ref={trigger} type="button" className="thread-trigger" aria-expanded={open} aria-controls={panelId} disabled={disabled}
        aria-label={`Sessions. Current: ${active ? threadTitle(active) : 'New session'}`} onClick={() => (open ? close(false) : setOpen(true))}>
        <span className="thread-trigger-title">{active ? threadTitle(active) : 'New session'}</span> <span aria-hidden="true">▾</span>
      </button>
      <button type="button" className="new-session-button" disabled={disabled} onClick={() => { close(false); onCreate(); }} aria-label="New session" title="New session"><span aria-hidden="true">＋</span></button>
      {open && (
        <div className="thread-panel" id={panelId} role="group" aria-label="Your refinement sessions">
          {threads.length === 0 ? <p className="thread-empty">No sessions yet. Send a message to start one.</p> : (
            <ul className="thread-list">
              {threads.map((thread) => {
                const badge = badges[thread.status];
                const editing = renaming?.id === thread.id;
                return (
                  <li key={thread.id} className="thread-row" data-active={thread.id === activeThreadId || undefined}>
                    {editing ? (
                      <form className="thread-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(undefined); } }}>
                        <input autoFocus aria-label="Session name" value={renaming.title} maxLength={120} onChange={(event) => setRenaming({ id: thread.id, title: event.target.value })} />
                        <button type="submit" className="button button-primary button-small" disabled={pending || !renaming.title.trim()}>Save</button>
                        <button type="button" className="button button-secondary button-small" onClick={() => setRenaming(undefined)}>Cancel</button>
                      </form>
                    ) : confirming === thread.id ? (
                      <div className="thread-confirm">
                        <span>Delete “{threadTitle(thread)}” and its conversation? The item and accepted changes stay.</span>
                        <button type="button" className="button button-danger button-small" disabled={pending} onClick={() => void run(() => onDelete(thread.id), 'Could not delete the session.', () => setConfirming(undefined))}>Delete session</button>
                        <button type="button" className="button button-secondary button-small" onClick={() => setConfirming(undefined)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <button type="button" className="thread-select" aria-current={thread.id === activeThreadId ? 'true' : undefined} onClick={() => { close(true); if (thread.id !== activeThreadId) onSelect(thread.id); }}>
                          <span className="thread-title">{threadTitle(thread)}</span>
                          <span className="thread-meta">
                            <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
                            {badge && <span className="badge thread-badge" data-status={thread.status}>{badge}</span>}
                          </span>
                        </button>
                        <button type="button" className="icon-button" aria-label={`Rename ${threadTitle(thread)}`} title="Rename" onClick={() => { setConfirming(undefined); setRenaming({ id: thread.id, title: thread.title ?? '' }); }}><span aria-hidden="true">✎</span></button>
                        <button type="button" className="icon-button" aria-label={`Delete ${threadTitle(thread)}`} title="Delete" onClick={() => { setRenaming(undefined); setConfirming(thread.id); }}><span aria-hidden="true">🗑</span></button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="thread-error" role="alert">{error}</p>}
          <p className="thread-private">Only you can see your sessions.</p>
        </div>
      )}
    </div>
  );
}
