import type { Notifications } from './useNotifications';

export function Toast({ notifications: { error, notice, action, clear } }: { notifications: Pick<Notifications, 'error' | 'notice' | 'action' | 'clear'> }) {
  if (!error && !notice) return null;
  return <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}>
    <span aria-hidden="true">{error ? '!' : '✓'}</span>
    <p>{error || notice}</p>
    {action && <button type="button" className="toast-action" onClick={() => { clear(); action.onClick(); }}>{action.label}</button>}
    <button type="button" onClick={clear} aria-label="Dismiss notification"><span aria-hidden="true">×</span></button>
  </div>;
}
