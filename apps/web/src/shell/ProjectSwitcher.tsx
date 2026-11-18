import { useRef, useState } from 'react';
import type { Project } from '../api';
import { Menu, type MenuEntry } from './Menu';
import { NewProjectDialog } from './NewProjectDialog';

export interface ProjectControls {
  projects: Project[];
  /** A project mutation is running; project actions are disabled. */
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onImport: (file: File) => void;
}

/**
 * Project menu button: lists the projects (radio items), "New project…", "Import project…" and, for the current project,
 * "Project settings…" plus the owner-only "Rename project" and "Delete project". Export lives in the project settings.
 */
export function ProjectSwitcher({ project, controls, locked, onOpenProjectSettings }: { project?: Project; controls: ProjectControls; locked?: boolean; onOpenProjectSettings?: () => void }) {
  const [creating, setCreating] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const disabled = controls.busy || Boolean(locked);
  const isOwner = project?.role === 'owner';

  const items: MenuEntry[] = [
    ...controls.projects.map((entry): MenuEntry => ({ id: `project-${entry.id}`, label: entry.name, checked: entry.id === project?.id, disabled, onSelect: () => controls.onSelect(entry.id) })),
    ...(controls.projects.length ? [{ id: 'sep-projects', separator: true } as const] : []),
    { id: 'new', label: 'New project…', disabled: controls.busy, onSelect: () => setCreating(true) },
    { id: 'import', label: 'Import project…', disabled: controls.busy, onSelect: () => importInput.current?.click() },
    ...(project ? [
      { id: 'sep-current', separator: true } as const,
      ...(onOpenProjectSettings ? [{ id: 'settings', label: 'Project settings…', onSelect: onOpenProjectSettings }] : []),
      ...(isOwner ? [
        { id: 'rename', label: 'Rename project', disabled, onSelect: () => { const next = window.prompt('Project name', project.name); if (next !== null) void controls.onRename(next); } },
        { id: 'delete', label: 'Delete project', danger: true, disabled, onSelect: controls.onDelete },
      ] : []),
    ] : []),
  ];

  return <>
    <Menu label={project ? `Project: ${project.name}` : 'Choose a project'} className="project-switcher" triggerClassName="topbar-button switcher-button" items={items}
      trigger={<><span className="workspace-dot" aria-hidden="true" /><span className="switcher-name">{project?.name ?? 'Choose a project'}</span><span aria-hidden="true" className="switcher-caret">▾</span></>} />
    <input ref={importInput} type="file" accept=".json,application/json" hidden aria-label="Project backup file"
      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) controls.onImport(file); }} />
    {creating && <NewProjectDialog onCreate={controls.onCreate} onClose={() => setCreating(false)} />}
  </>;
}
