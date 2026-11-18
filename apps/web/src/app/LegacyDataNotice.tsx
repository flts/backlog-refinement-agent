import { useEffect, useState } from 'react';
import { dismissLegacyNotice, isLegacyNoticeDismissed, legacyDataExists, removeLegacyData, type LegacyDataDeps } from '../infrastructure/legacy-data';

/** The app no longer uses IndexedDB, so an old database can be offered for removal. */
export const LEGACY_NOTICE_ENABLED = true;

export function LegacyDataNotice({ enabled = LEGACY_NOTICE_ENABLED, deps, confirm = (message: string) => window.confirm(message) }: {
  enabled?: boolean; deps?: LegacyDataDeps; confirm?: (message: string) => boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || isLegacyNoticeDismissed(deps)) return;
    let active = true;
    void legacyDataExists(deps).then((exists) => { if (active && exists) setVisible(true); });
    return () => { active = false; };
  }, [enabled, deps]);

  if (!visible) return null;

  function dismiss() {
    dismissLegacyNotice(deps);
    setVisible(false);
  }

  async function remove() {
    if (!confirm('Permanently remove the old projects, backlog items and sources stored in this browser? They are not migrated and cannot be recovered.')) return;
    setBusy(true); setError('');
    try {
      await removeLegacyData(deps);
      setStatus('Old local data removed.');
      dismissLegacyNotice(deps);
      setVisible(false);
    } catch (cause) {
      setError(`Could not remove old local data: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setBusy(false); }
  }

  return <section className="legacy-notice" aria-labelledby="legacy-notice-title">
    <h2 id="legacy-notice-title">Old local data found</h2>
    <p>Backlog Studio now stores your work on the server. Projects, items and sources saved earlier in this browser are not migrated. You can remove them from this browser.</p>
    {error && <p role="alert" className="field-error">{error}</p>}
    <div className="legacy-notice-actions">
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void remove()}>Remove old local data</button>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={dismiss}>Dismiss</button>
    </div>
    <p className="sr-only" role="status">{status}</p>
  </section>;
}
