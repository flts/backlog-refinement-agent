import { useRef, useState } from 'react';
import type { Project, ProjectSource } from '../domain/project';

type Props = {
  projects: Project[];
  project?: Project;
  sources: ProjectSource[];
  busy: boolean;
  endpoint: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onAddFile: (file: File) => void;
  onAddUrl: (name: string, url: string, text: string) => Promise<boolean>;
  onEditText: (source: ProjectSource, text: string) => Promise<boolean>;
  onFetch: (source: ProjectSource) => void;
  onToggle: (source: ProjectSource, selected: boolean) => void;
  onRemove: (source: ProjectSource) => void;
  onExport: () => void;
  onImport: (file: File) => void;
};

export function ProjectPanel(props: Props) {
  const { projects, project, sources, busy } = props;
  const [name, setName] = useState('');
  const [referenceName, setReferenceName] = useState('');
  const [url, setUrl] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const [editing, setEditing] = useState<string>();
  const [editedText, setEditedText] = useState('');
  const importInput = useRef<HTMLInputElement>(null);

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
      {project && <>
        <button className="button button-secondary button-small" disabled={busy} onClick={props.onExport}>Export project</button>
        <button className="button button-secondary button-small" disabled={busy} onClick={() => {
          const next = window.prompt('Project name', project.name);
          if (next !== null) void props.onRename(next);
        }}>Rename project</button>
        <button className="button button-secondary button-small" disabled={busy} onClick={props.onDelete}>Delete project</button>
      </>}
    </div>
    {project && <p className="composer-hint">AI context: {sources.filter((source) => source.selected).length} selected sources sent to {props.endpoint || 'the configured endpoint (not set)'}.</p>}
    {project && <details>
      <summary>Project sources ({sources.length})</summary>
      <p>Only selected sources are sent to the AI endpoint {props.endpoint || '(not configured)'} when refining, decomposing, or assessing an item. Sources begin unselected.</p>
      <label>Add PDF or text file <input type="file" accept=".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) props.onAddFile(file); }} /></label>
      <form className="project-reference-form" onSubmit={(event) => { event.preventDefault(); void addReference(); }}>
        <input aria-label="Reference name" placeholder="Reference name" value={referenceName} onChange={(event) => setReferenceName(event.target.value)} maxLength={200} required disabled={busy} />
        <input aria-label="Reference URL" type="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} required disabled={busy} />
        <textarea aria-label="Reference text" placeholder="Paste reference text (optional)" value={referenceText} onChange={(event) => setReferenceText(event.target.value)} disabled={busy} />
        <button className="button button-secondary button-small" disabled={busy}>Add reference</button>
      </form>
      {sources.length === 0 && <p>No sources added yet.</p>}
      <ul className="project-sources">
        {sources.map((source) => <li key={source.id}>
          <label><input type="checkbox" checked={source.selected} disabled={busy} onChange={(event) => props.onToggle(source, event.target.checked)} /> {source.name}</label>
          {source.url && <a href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a>}
          <span>{source.text.length.toLocaleString()} characters</span>
          {source.kind === 'url' && <button className="button button-secondary button-small" disabled={busy} onClick={() => props.onFetch(source)}>Fetch text</button>}
          {source.kind === 'url' && <button className="button button-secondary button-small" disabled={busy} onClick={() => { setEditing(source.id); setEditedText(source.text); }}>Edit text</button>}
          <button className="button button-secondary button-small" disabled={busy} onClick={() => props.onRemove(source)}>Remove</button>
          {editing === source.id && <div>
            <textarea aria-label={`Text for ${source.name}`} value={editedText} onChange={(event) => setEditedText(event.target.value)} />
            <button className="button button-secondary button-small" disabled={busy} onClick={() => { void props.onEditText(source, editedText).then((saved) => { if (saved) setEditing(undefined); }); }}>Save text</button>
            <button className="button button-secondary button-small" onClick={() => setEditing(undefined)}>Cancel</button>
          </div>}
        </li>)}
      </ul>
    </details>}
  </section>;
}
