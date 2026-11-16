import { useRef, useState } from 'react';
import type { Project, Source, SourceList } from '../api';
import { PALETTE_EVENTS, usePaletteEvent } from '../palette/events';
import { SourcesDrawer } from '../sources';

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
  onShare?: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
};

export function ProjectPanel(props: Props) {
  const { projects, project, sources, pinnedBudget, busy } = props;
  const [name, setName] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  usePaletteEvent(PALETTE_EVENTS.openSources, () => { if (project && !busy) setSourcesOpen(true); });
  const isOwner = project?.role === 'owner';

  async function createProject() {
    if (await props.onCreate(name)) setName('');
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
      {project && <button type="button" className="button button-secondary button-small" aria-haspopup="dialog" onClick={() => setSourcesOpen(true)}>Sources ({sources.length})</button>}
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
    {project && sourcesOpen && <SourcesDrawer projectId={project.id} projectName={project.name} onClose={() => setSourcesOpen(false)} />}
  </section>;
}
