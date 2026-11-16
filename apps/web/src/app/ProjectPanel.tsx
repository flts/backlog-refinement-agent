import { useRef, useState } from 'react';
import type { Project, Source, SourceList, SourceMode } from '../api';

const modeLabel: Record<SourceMode, string> = { pinned: 'Pinned', searchable: 'Searchable', excluded: 'Excluded' };
const indexLabel: Record<Source['indexStatus'], string> = { pending: 'Waiting to index', indexing: 'Indexing…', indexed: 'Indexed', failed: 'Indexing failed', skipped: 'Not indexed' };

type Props = {
  projects: Project[];
  project?: Project;
  sources: Source[];
  pinnedBudget?: SourceList['pinnedBudget'];
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onAddFile: (file: File) => void;
  onAddUrl: (name: string, url: string, text: string) => Promise<boolean>;
  onChangeMode: (source: Source, mode: SourceMode) => void;
  onRemove: (source: Source) => void;
  onShare?: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
};

export function ProjectPanel(props: Props) {
  const { projects, project, sources, pinnedBudget, busy } = props;
  const [name, setName] = useState('');
  const [referenceName, setReferenceName] = useState('');
  const [url, setUrl] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const isOwner = project?.role === 'owner';

  async function createProject() {
    if (await props.onCreate(name)) setName('');
  }

  async function addReference() {
    if (await props.onAddUrl(referenceName, url, referenceText)) {
      setReferenceName('');
      setUrl('');
      setReferenceText('');
    }
  }

  return <section className="project-panel" aria-label="Projects and sources">
    <div className="project-toolbar">
      <label>Project
        <select aria-label="Choose project" value={project?.id ?? ''} disabled={busy} onChange={(event) => props.onSelect(event.target.value)}>
          <option value="" disabled>Choose a project</option>
          {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <form onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
        <label className="sr-only" htmlFor="new-project-name">New project name</label>
        <input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="New project name" required maxLength={200} disabled={busy} />
        <button className="button button-secondary button-small" disabled={busy}>Create project</button>
      </form>
      <button className="button button-secondary button-small" disabled={busy} onClick={() => importInput.current?.click()}>Import project</button>
      <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) props.onImport(file); }} />
      {project && props.onShare && <button className="button button-secondary button-small" disabled={busy} onClick={props.onShare}>Share</button>}
      {project && isOwner && <>
        <button className="button button-secondary button-small" disabled={busy} onClick={props.onExport}>Export project</button>
        <button className="button button-secondary button-small" disabled={busy} onClick={() => {
          const next = window.prompt('Project name', project.name);
          if (next !== null) void props.onRename(next);
        }}>Rename project</button>
        <button className="button button-secondary button-small" disabled={busy} onClick={props.onDelete}>Delete project</button>
      </>}
    </div>
    {project && <p className="composer-hint">AI context: {sources.filter((source) => source.mode === 'pinned').length} pinned and {sources.filter((source) => source.mode === 'searchable').length} searchable sources are available to the agent when refining{pinnedBudget ? ` (pinned: ${pinnedBudget.used.toLocaleString()} of ${pinnedBudget.limit.toLocaleString()} characters)` : ''}.</p>}
    {project && <details>
      <summary>Project sources ({sources.length})</summary>
      <p>Pinned sources are always sent to the agent, searchable sources are looked up when relevant, excluded sources are never sent. New sources are searchable.</p>
      <div className="project-file-upload">
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => sourceInput.current?.click()}>Add PDF or text file</button>
        <span>PDF, TXT or Markdown</span>
        <input ref={sourceInput} aria-label="Add PDF or text file" type="file" accept=".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf" disabled={busy} hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) props.onAddFile(file); }} />
      </div>
      <form className="project-reference-form" onSubmit={(event) => { event.preventDefault(); void addReference(); }}>
        <input aria-label="Reference name" placeholder="Reference name" value={referenceName} onChange={(event) => setReferenceName(event.target.value)} maxLength={200} required disabled={busy} />
        <input aria-label="Reference URL" type="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} required disabled={busy} />
        <textarea aria-label="Reference text" placeholder="Paste reference text (optional, used when the page cannot be fetched)" value={referenceText} onChange={(event) => setReferenceText(event.target.value)} disabled={busy} />
        <button className="button button-secondary button-small" disabled={busy}>Add reference</button>
      </form>
      {sources.length === 0 && <p>No sources added yet.</p>}
      <ul className="project-sources">
        {sources.map((source) => <li key={source.id}>
          <label>{source.name}
            <select aria-label={`Mode of ${source.name}`} value={source.mode} disabled={busy} onChange={(event) => props.onChangeMode(source, event.target.value as SourceMode)}>
              {(Object.keys(modeLabel) as SourceMode[]).map((mode) => <option key={mode} value={mode}>{modeLabel[mode]}</option>)}
            </select>
          </label>
          {source.url && <a href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>}
          <span>{source.charCount.toLocaleString()} characters</span>
          <span>{indexLabel[source.indexStatus]}</span>
          {source.indexError && <span role="note">{source.indexError}</span>}
          <button className="button button-secondary button-small" disabled={busy} aria-label={`Remove ${source.name}`} onClick={() => props.onRemove(source)}>Remove</button>
        </li>)}
      </ul>
    </details>}
  </section>;
}
