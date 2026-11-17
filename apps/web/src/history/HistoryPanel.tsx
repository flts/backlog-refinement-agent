import { useId, useState } from 'react';
import { useRevision, type Revision } from '../api';
import { attributionText } from '../collab';
import { DiffView } from '../settings/DiffView';
import { formatAbsolute, formatRelative } from './time';

export const originBadge: Record<Revision['origin'], string> = { manual: 'Edited', agent: 'Via agent', restore: 'Restored' };

type Mode = 'view' | 'current' | 'previous';

export interface HistoryPanelProps {
  projectId: string;
  /** The item as shown right now (unsaved edits included); the "current" side of a comparison. */
  item: { id: string; title: string; document: string };
  /** Saved versions, newest first; the first one is the current saved content. */
  revisions: Revision[];
  loading?: boolean;
  /** Resolves an actor email to a display name. */
  nameOf: (email: string) => string;
  busy?: boolean;
  /** Restores a version as a new version. Resolves to whether it worked (errors, including conflicts, are reported by the caller). */
  onRestore: (revisionId: string) => Promise<boolean>;
}

function RevisionTime({ date }: { date: string }) {
  return <time dateTime={date} title={formatAbsolute(date)}>{formatRelative(date)}</time>;
}

function RevisionDetail({ projectId, item, revisions, selected, nameOf, busy, onRestore }: Pick<HistoryPanelProps, 'projectId' | 'item' | 'revisions' | 'nameOf' | 'busy' | 'onRestore'> & { selected: Revision }) {
  const [mode, setMode] = useState<Mode>('view');
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const modeName = useId();
  const index = revisions.findIndex((revision) => revision.id === selected.id);
  const previous = revisions[index + 1];
  const isCurrent = index === 0;
  const selectedDetail = useRevision(projectId, item.id, selected.id);
  const previousDetail = useRevision(projectId, item.id, mode === 'previous' ? previous?.id : undefined);

  async function restore() {
    setRestoring(true);
    try { await onRestore(selected.id); } finally { setRestoring(false); setConfirming(false); }
  }

  const modes: { id: Mode; label: string; disabled?: boolean }[] = [
    { id: 'view', label: 'This version' },
    { id: 'current', label: 'Compare with current' },
    { id: 'previous', label: 'Compare with previous', disabled: !previous },
  ];
  const loadFailed = selectedDetail.isError || (mode === 'previous' && previousDetail.isError);
  const ready = selectedDetail.data && (mode !== 'previous' || previousDetail.data);

  return <section className="history-detail" aria-label={`Version ${selected.version}`}>
    <div className="history-detail-head">
      <h3>Version {selected.version}{isCurrent && <span className="history-current"> · current</span>}</h3>
      <p>{attributionText(selected, nameOf)} · <RevisionTime date={selected.createdAt} /></p>
    </div>
    <fieldset className="history-modes">
      <legend className="sr-only">What to show for version {selected.version}</legend>
      {modes.map((entry) => <label key={entry.id} className={`history-mode ${mode === entry.id ? 'active' : ''}`}>
        <input type="radio" name={modeName} value={entry.id} checked={mode === entry.id} disabled={entry.disabled} onChange={() => setMode(entry.id)} /> {entry.label}
      </label>)}
    </fieldset>
    <div className="history-content">
      {loadFailed ? <p className="history-note" role="alert">Could not load this version.</p>
        : !ready ? <p className="history-note" role="status">Loading version…</p>
          : mode === 'view' ? <>
            <p className="history-title"><span className="subtle-label">Title</span> {selectedDetail.data.title}</p>
            <pre className="history-document" tabIndex={0} aria-label={`Document of version ${selected.version}`}>{selectedDetail.data.document || ' '}</pre>
          </>
            : mode === 'current' ? <DiffView before={selectedDetail.data.document} after={item.document} beforeLabel={`Version ${selected.version}`} afterLabel="Current version" />
              : <DiffView before={previousDetail.data!.document} after={selectedDetail.data.document} beforeLabel={`Version ${previous.version}`} afterLabel={`Version ${selected.version}`} />}
    </div>
    {isCurrent ? <p className="history-note">This is the current version.</p>
      : confirming ? <div className="history-confirm" role="group" aria-label="Confirm restore">
        <p>Restore version {selected.version} as a new version? The current content stays in the history.</p>
        <button type="button" className="button button-primary button-small" autoFocus disabled={restoring || busy} onClick={() => void restore()}>{restoring ? 'Restoring…' : `Restore version ${selected.version}`}</button>
        <button type="button" className="button button-secondary button-small" disabled={restoring} onClick={() => setConfirming(false)}>Cancel</button>
      </div>
        : <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => setConfirming(true)}>Restore this version</button>}
  </section>;
}

/** Version history of one item: who changed what (newest first), compare any version with the current or previous one, and restore it. */
export function HistoryPanel({ projectId, item, revisions, loading = false, nameOf, busy = false, onRestore }: HistoryPanelProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = revisions.find((revision) => revision.id === selectedId);
  if (loading && !revisions.length) return <p className="history-note" role="status">Loading history…</p>;
  if (!revisions.length) return <p className="history-note">No saved versions yet. Versions appear here as soon as the item is saved.</p>;
  return <div className="history-panel">
    {revisions.length === 1 && <p className="history-note">Only one version so far. Later changes, by you, teammates or the agent, are listed here to compare and restore.</p>}
    <ol className="history-list" aria-label="Versions, newest first">
      {revisions.map((revision, index) => <li key={revision.id}>
        <button type="button" className={`history-entry ${revision.id === selected?.id ? 'selected' : ''}`} aria-pressed={revision.id === selected?.id}
          onClick={() => setSelectedId(revision.id === selected?.id ? undefined : revision.id)}>
          <span className="history-dot" aria-hidden="true" />
          <span className="history-entry-main">
            <span className="history-entry-top"><strong>v{revision.version}</strong><span className="history-author">{nameOf(revision.actor)}</span>
              <span className={`history-badge history-badge-${revision.origin}`}>{originBadge[revision.origin]}</span>
              {revision.label && <span className="revision-label">{revision.label}</span>}
              {index === 0 && <span className="history-badge history-badge-current">Current</span>}</span>
            <RevisionTime date={revision.createdAt} />
          </span>
        </button>
      </li>)}
    </ol>
    {selected ? <RevisionDetail key={selected.id} projectId={projectId} item={item} revisions={revisions} selected={selected} nameOf={nameOf} busy={busy} onRestore={async (id) => { const ok = await onRestore(id); if (ok) setSelectedId(undefined); return ok; }} />
      : revisions.length > 1 && <p className="history-note">Select a version to view it, compare it with the current or previous version, or restore it.</p>}
  </div>;
}
