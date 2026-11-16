import { useState, type FormEvent } from 'react';
import { useBacklogClient, useDeleteSource, useReindexSource, useUpdateSource, fetchSourceFile, type Source, type SourceMode } from '../api';
import { downloadFile } from '../app/files';
import { ItemMenu, type MenuAction } from '../app/ItemMenu';
import { sourceErrorText } from './errors';

export const modeLabel: Record<SourceMode, string> = { pinned: 'Pinned', searchable: 'Searchable', excluded: 'Excluded' };
const modeHint: Record<SourceMode, string> = { pinned: 'full text in every request', searchable: 'matching passages only', excluded: 'never sent' };
export const indexLabel: Record<Source['indexStatus'], { glyph: string; text: string }> = {
  pending: { glyph: '◔', text: 'Waiting to index' },
  indexing: { glyph: '◑', text: 'Indexing…' },
  indexed: { glyph: '✓', text: 'Indexed' },
  failed: { glyph: '!', text: 'Indexing failed' },
  skipped: { glyph: '–', text: 'Not indexed' },
};
const kindLabel: Record<Source['kind'], { glyph: string; text: string }> = { file: { glyph: '▤', text: 'File' }, url: { glyph: '↗', text: 'Web page' }, text: { glyph: '¶', text: 'Pasted text' } };

function size(source: Source): string {
  const parts = [`${source.charCount.toLocaleString()} characters`];
  if (source.pageCount) parts.push(`${source.pageCount} ${source.pageCount === 1 ? 'page' : 'pages'}`);
  return parts.join(' · ');
}

export function SourceItem({ projectId, source }: { projectId: string; source: Source }) {
  const client = useBacklogClient();
  const update = useUpdateSource(projectId);
  const remove = useDeleteSource(projectId);
  const reindex = useReindexSource(projectId);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(source.name);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const status = indexLabel[source.indexStatus];
  const kind = kindLabel[source.kind];
  const busy = update.isPending || remove.isPending || reindex.isPending;

  async function attempt(action: () => Promise<unknown>, success?: string) {
    setError(''); setNotice('');
    try { await action(); if (success) setNotice(success); }
    catch (cause) { setError(sourceErrorText(cause)); }
  }

  function changeMode(mode: SourceMode) {
    if (mode !== source.mode) void attempt(() => update.mutateAsync({ source, changes: { mode } }));
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === source.name) { setRenaming(false); return; }
    await attempt(() => update.mutateAsync({ source, changes: { name: next } }));
    setRenaming(false);
  }

  const actions: MenuAction[] = [
    ...(source.hasFile ? [{ id: 'download', label: 'Download original', onSelect: () => void attempt(async () => { downloadFile(source.name, await fetchSourceFile(client, projectId, source.id), source.mediaType ?? 'application/octet-stream'); }) }] : []),
    { id: 'reindex', label: 'Reindex', onSelect: () => void attempt(() => reindex.mutateAsync(source), 'Reindexing has been queued.') },
    { id: 'rename', label: 'Rename', onSelect: () => { setName(source.name); setRenaming(true); } },
    { id: 'remove', label: 'Remove…', danger: true, onSelect: () => setConfirmingRemove(true) },
  ];

  return <li className="source-item" aria-busy={busy}>
    <div className="source-head">
      <span className="source-kind" aria-hidden="true">{kind.glyph}</span>
      <div className="source-title">
        {renaming
          ? <form className="source-rename" onSubmit={(event) => void submitRename(event)}>
            <label className="sr-only" htmlFor={`rename-${source.id}`}>New name for {source.name}</label>
            <input id={`rename-${source.id}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required autoFocus
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setRenaming(false); } }} />
            <button className="button button-primary button-small" disabled={busy}>Save</button>
            <button type="button" className="button button-secondary button-small" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
          : <strong className="source-name">{source.name}</strong>}
        <span className="source-meta"><span className="sr-only">{kind.text}: </span>{size(source)}</span>
        {source.url && <a className="source-url" href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>}
      </div>
      <ItemMenu label={`Actions for ${source.name}`} actions={actions} />
    </div>

    <div className="source-controls">
      <div className="segmented" role="radiogroup" aria-label={`Mode of ${source.name}`}>
        {(Object.keys(modeLabel) as SourceMode[]).map((mode) => <label key={mode} className={source.mode === mode ? 'is-selected' : undefined} title={modeHint[mode]}>
          <input type="radio" name={`mode-${source.id}`} value={mode} checked={source.mode === mode} disabled={busy} onChange={() => changeMode(mode)} />
          <span>{modeLabel[mode]}</span>
        </label>)}
      </div>
      <span className={`source-status status-${source.indexStatus}`}><span aria-hidden="true">{status.glyph}</span> {status.text}</span>
    </div>
    {source.indexError && <p className="source-index-error">{source.indexError}</p>}

    {confirmingRemove && <div className="source-confirm" role="group" aria-label={`Confirm removing ${source.name}`}>
      <p>Remove “{source.name}” from this project? Its original file and search index are deleted.</p>
      <div className="sources-actions">
        <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => void attempt(() => remove.mutateAsync(source))}>Remove source</button>
        <button type="button" className="button button-secondary button-small" onClick={() => setConfirmingRemove(false)} autoFocus>Keep</button>
      </div>
    </div>}
    <p role="status" className="source-notice">{notice}</p>
    {error && <p role="alert" className="sources-error">{error}</p>}
  </li>;
}
