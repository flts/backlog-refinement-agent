import { useEffect, useState } from 'react';
import { inspectLegacyData, openDatabaseAfterLegacyReset, type LegacyDataInspection } from '../infrastructure/storage/bootstrap';
import { BacklogDatabase, LegacyDataConfirmationRequiredError } from '../infrastructure/storage/database';
import { Projects } from './Projects';

export function Bootstrap() {
  const [inspection, setInspection] = useState<LegacyDataInspection>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    inspectLegacyData().then(async (result) => {
      if (!active) return;
      setInspection(result);
      if (!result.needsConfirmation) {
        const db = new BacklogDatabase();
        db.on('blocked', () => { if (active) setError('Close other tabs using the backlog, then try again.'); });
        try {
          await db.open();
          db.close();
          if (active) { setError(''); setReady(true); }
        } catch (cause) {
          db.close();
          if (cause instanceof LegacyDataConfirmationRequiredError) {
            const latest = await inspectLegacyData();
            if (active) setInspection(latest);
          } else throw cause;
        }
      }
    }).catch((cause: unknown) => {
      if (active) setError(`Could not inspect local data: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return () => { active = false; };
  }, []);

  async function reset() {
    if (!window.confirm('Permanently discard the existing backlog items, relationships and refinement sessions? Current-format settings will be kept.')) return;
    setBusy(true);
    setError('');
    try {
      const db = await openDatabaseAfterLegacyReset({
        confirmed: true,
        onBlocked: () => setError('Close other tabs using the backlog to finish the reset.'),
      });
      db.close();
      setReady(true);
    } catch (cause) {
      setError(`Could not reset the local backlog: ${cause instanceof Error ? cause.message : String(cause)}. Close other open tabs and try again.`);
    } finally { setBusy(false); }
  }

  if (ready) return <Projects />;
  return <main className="loading-screen">
    <span className="brand-mark">b.</span>
    {inspection?.needsConfirmation ? <>
      <h1>Start a new project workspace</h1>
      <p>The new version cannot use your existing backlog. Starting fresh permanently removes {inspection.backlogItems} items, {inspection.relationships} relationships and {inspection.sessions} sessions from this browser. Current-format settings are retained.</p>
      <button className="button button-primary" disabled={busy} onClick={() => void reset()}>Discard old backlog and continue</button>
      <p>Until you confirm, your existing data remains unchanged.</p>
    </> : !error && <p>Checking your local backlog…</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
