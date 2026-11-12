import { useCallback, useEffect, useState } from 'react';
import type { Project, ProjectSource } from '../domain/project';
import { ProjectBackupRepository } from '../infrastructure/storage/ProjectBackupRepository';
import { extractFileText, extractUrlText, SOURCE_LIMITS } from '../infrastructure/source-extraction';
import { copyProjectBackup, parseProjectBackup, serializeProjectBackup } from '../application/project-backup';
import { downloadFile } from './config-io';
import { ProjectPanel } from './ProjectPanel';
import { projectRepository } from './services';
import { errorText } from './useNotifications';
import App from './App';

const backups = new ProjectBackupRepository();
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const selectedProjectKey = 'selected-project-id';

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const project = projects.find((entry) => entry.id === projectId);

  const refresh = useCallback(async (preferred?: string) => {
    const list = await projectRepository.listProjects();
    setProjects(list);
    setProjectsLoaded(true);
    setProjectId((current) => list.some((item) => item.id === preferred) ? preferred
      : list.some((item) => item.id === current) ? current : list[0]?.id);
  }, []);

  useEffect(() => {
    let saved: string | undefined;
    try { saved = localStorage.getItem(selectedProjectKey) ?? undefined; }
    catch (cause) { setError(`Could not restore the selected project: ${errorText(cause)}`); }
    refresh(saved).catch((cause: unknown) => setError(`Could not load projects: ${errorText(cause)}`)).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (loading || !projectsLoaded) return;
    try {
      if (projectId) localStorage.setItem(selectedProjectKey, projectId);
      else localStorage.removeItem(selectedProjectKey);
    } catch (cause) { setError(`Could not remember the selected project: ${errorText(cause)}`); }
  }, [loading, projectId, projectsLoaded]);

  useEffect(() => {
    let active = true;
    setSources([]);
    if (projectId) projectRepository.listSources(projectId)
      .then((list) => { if (active) setSources(list); })
      .catch((cause: unknown) => { if (active) setError(`Could not load sources: ${errorText(cause)}`); });
    return () => { active = false; };
  }, [projectId]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true); setError(''); setNotice('');
    try { await action(); return true; }
    catch (cause) { setError(errorText(cause)); return false; }
    finally { setBusy(false); }
  }

  function panel(requestBusy: boolean, endpoint: string) {
    const disabled = busy || requestBusy;
    return <ProjectPanel projects={projects} project={project} sources={sources.filter((source) => source.projectId === project?.id)} busy={disabled} endpoint={endpoint}
      onSelect={(next) => { if (!disabled) setProjectId(next); }}
      onCreate={(name) => run(async () => {
        const time = now();
        const created = await projectRepository.createProject({ id: id(), name: name.trim(), createdAt: time, updatedAt: time });
        await refresh(created.id);
        setNotice('Project created.');
      })}
      onRename={(name) => run(async () => {
        if (!project) throw new Error('Choose a project first.');
        await projectRepository.updateProject({ ...project, name: name.trim(), updatedAt: now() });
        await refresh(project.id);
        setNotice('Project renamed.');
      })}
      onDelete={() => {
        if (!project || !window.confirm(`Delete “${project.name}” and all its sources, backlog items and refinement sessions?`)) return;
        void run(async () => { await projectRepository.deleteProject(project.id); await refresh(); setNotice('Project deleted.'); });
      }}
      onAddFile={(file) => {
        if (!project) return;
        void run(async () => {
          const text = await extractFileText(file);
          const time = now();
          await projectRepository.saveSource({ id: id(), projectId: project.id, name: file.name, kind: 'file', mediaType: file.type || 'application/octet-stream', text, selected: false, file, createdAt: time, updatedAt: time });
          setSources(await projectRepository.listSources(project.id));
          setNotice('Source added locally.');
        });
      }}
      onAddUrl={(name, value, text) => run(async () => {
        if (!project) throw new Error('Choose a project first.');
        let url: URL;
        try { url = new URL(value); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS URL without credentials.');
        if (text.length > SOURCE_LIMITS.text) throw new Error('Reference text exceeds the source size limit.');
        const time = now();
        await projectRepository.saveSource({ id: id(), projectId: project.id, name: name.trim(), kind: 'url', mediaType: 'text/plain', text, selected: false, url: url.href, createdAt: time, updatedAt: time });
        setSources(await projectRepository.listSources(project.id));
        setNotice('Reference added locally.');
      })}
      onEditText={(source, text) => run(async () => {
        if (text.length > SOURCE_LIMITS.text) throw new Error('Reference text exceeds the source size limit.');
        await projectRepository.saveSource({ ...source, text, updatedAt: now() });
        setSources(await projectRepository.listSources(source.projectId));
        setNotice('Reference updated.');
      })}
      onFetch={(source) => {
        void run(async () => {
          if (!source.url) throw new Error('This reference has no URL.');
          const text = await extractUrlText(source.url);
          if (!text.trim()) throw new Error('The reference returned no readable text.');
          await projectRepository.saveSource({ ...source, text, updatedAt: now() });
          setSources(await projectRepository.listSources(source.projectId));
          setNotice('Reference text fetched.');
        });
      }}
      onToggle={(source, selected) => {
        void run(async () => {
          await projectRepository.saveSource({ ...source, selected, updatedAt: now() });
          setSources(await projectRepository.listSources(source.projectId));
        });
      }}
      onRemove={(source) => {
        if (!window.confirm(`Remove “${source.name}” from this project?`)) return;
        void run(async () => {
          await projectRepository.deleteSource(source.projectId, source.id);
          setSources(await projectRepository.listSources(source.projectId));
          setNotice('Source removed.');
        });
      }}
      onExport={() => {
        if (!project) return;
        void run(async () => {
          const json = await serializeProjectBackup(await backups.read(project.id));
          downloadFile(`${project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'project'}.json`, json, 'application/json');
          setNotice('Project exported.');
        });
      }}
      onImport={(file) => {
        void run(async () => {
          if (file.size > 50 * 1024 * 1024) throw new Error('Project backup exceeds the 50 MiB limit.');
          let backup = parseProjectBackup(await file.text());
          let replace = false;
          if (await projectRepository.getProject(backup.project.id)) {
            const choice = window.prompt(`“${backup.project.name}” already exists. Type "copy" to import a separate copy or "replace" to replace it. Cancel to stop.`, 'copy');
            if (choice === null) return;
            if (choice.trim().toLowerCase() === 'copy') backup = copyProjectBackup(backup);
            else if (choice.trim().toLowerCase() === 'replace') {
              if (!window.confirm(`Replace “${backup.project.name}” and all of its current contents?`)) return;
              replace = true;
            } else throw new Error('Import cancelled: choose copy or replace.');
          } else if (!window.confirm(`Import “${backup.project.name}” with ${backup.items.length} items, ${backup.sources.length} sources and ${backup.sessions.length} sessions?`)) return;
          await backups.write(backup, replace);
          setWorkspaceRevision((revision) => revision + 1);
          await refresh(backup.project.id);
          setSources(await projectRepository.listSources(backup.project.id));
          setNotice('Project imported.');
        });
      }}
    />;
  }

  if (loading) return <main className="loading-screen">Opening projects…</main>;
  return <>
    {project
      ? <App key={`${project.id}:${workspaceRevision}`} project={project} projectBusy={busy} renderProjectPanel={panel} />
      : <main>{panel(false, '')}<p>Create or import a project to start a backlog.</p></main>}
    {(error || notice) && <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}><p>{error || notice}</p><button aria-label="Dismiss notification" onClick={() => { setError(''); setNotice(''); }}>×</button></div>}
  </>;
}
