import type { ThreadStatus } from '../agent';

export const threadStatusText: Partial<Record<ThreadStatus, string>> = {
  awaiting_input: 'Needs your input',
  awaiting_review: 'Review changes',
  running: 'Agent is working',
};

/** Tree-row badge for the current user's own thread of an item; renders nothing for idle or unknown status. */
export function ThreadStatusBadge({ status }: { status?: ThreadStatus }) {
  const text = status && threadStatusText[status];
  if (!status || !text) return null;
  if (status === 'running') return <span className="thread-badge thread-badge-running"><span className="thread-spinner" aria-hidden="true" /><span className="sr-only">{text}</span></span>;
  return <span className={`thread-badge thread-badge-${status === 'awaiting_input' ? 'input' : 'review'}`}>{text}</span>;
}
