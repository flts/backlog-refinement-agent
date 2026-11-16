import { useEffect, useState } from 'react';
import {
  isVersionConflict, useCreateProject, useCreateSource, useDeleteProject, useDeleteSource, useExportProject, useImportProject, useProjects,
  useRenameProject, useSources, useUpdateSource,
  type Source, type SourceMode,
} from '../api';
import App from './App';
import { LegacyDataNotice } from './LegacyDataNotice';
import { ProjectPanel } from './ProjectPanel';
import { Toast } from './Toast';
import { downloadFile } from './files';
import { errorText, useNotifications } from './useNotifications';
import { ErrorScreen, LoadingScreen } from './StatusScreen';

const selectedProjectKey = 'selected-project-id';

export function Projects() {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [pickedId, setPickedId] = useState<string | undefined>(() => {
    try { return localStorage.getItem(selectedProjectKey) ?? undefined; } catch { return undefined; }
  });
  const project = projects.find((entry) => entry.id === pickedId) ?? projects[0];
  const projectId = project?.id;
  const sourcesQuery = useSources(projectId);
  const notifications = useNotifications();
  const { setError, setNotice, report } = notifications;

  const createProject = useCreateProject();
  const renameProject = useRenameProject();
  const deleteProject = useDeleteProject();
  const exportProject = useExportProject();
  const importProject = useImportProject();
  const createSource = useCreateSource(projectId ?? '');
  const updateSource = useUpdateSource(projectId ?? '');
  const deleteSource = useDeleteSource(projectId ?? '');
  const busy = [createProject, renameProject, deleteProject, exportProject, importProject, createSource, updateSource, deleteSource].some((mutation) => mutation.isPending);

  useEffect(() => {
    if (!projectsQuery.isSuccess) return;
    try {
      if (projectId) localStorage.setItem(selectedProjectKey, projectId);
      else localStorage.removeItem(selectedProjectKey);
    } catch (cause) { setError(`Could not remember the selected project: ${errorText(cause)}`); }
  }, [projectId, projectsQuery.isSuccess]);

  async function run(action: () => Promise<void>, failure?: string, subject = 'project'): Promise<boolean> {
    setError(''); setNotice('');
    try { await action(); return true; }
    catch (cause) {
      if (isVersionConflict(cause)) report(failure ?? 'Failed', cause, subject, () => void projectsQuery.refetch());
      else setError(failure ? `${failure}: ${errorText(cause)}` : errorText(cause));
      return false;
    }
  }

  function panel(requestBusy: boolean) {
    const disabled = busy || requestBusy;
    return <ProjectPanel projects={projects} project={project} sources={sourcesQuery.data?.items ?? []} pinnedBudget={sourcesQuery.data?.pinnedBudget} busy={disabled}
      onSelect={(next) => { if (!disabled) setPickedId(next); }}
      onCreate={(name) => run(async () => {
        const created = await createProject.mutateAsync(name);
        setPickedId(created.id);
        setNotice('Project created.');
      })}
      onRename={(name) => run(async () => {
        if (!project) throw new Error('Choose a project first.');
        await renameProject.mutateAsync({ project, name });
        setNotice('Project renamed.');
      }, 'Could not rename the project')}
      onDelete={() => {
        if (!project || !window.confirm(`Delete “${project.name}” and all its sources, backlog items and relationships?`)) return;
        void run(async () => { await deleteProject.mutateAsync(project); setPickedId(undefined); setNotice('Project deleted.'); }, 'Could not delete the project');
      }}
      onAddFile={(file) => { void run(async () => { await createSource.mutateAsync({ kind: 'file', file }); setNotice('Source added; it is being indexed.'); }, 'Could not add the source', 'source'); }}
      onAddUrl={(name, value, text) => run(async () => {
        let url: URL;
        try { url = new URL(value); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS URL without credentials.');
        await createSource.mutateAsync({ kind: 'url', url: url.href, pastedText: text || undefined, name: name.trim() });
        setNotice('Reference added.');
      }, 'Could not add the reference', 'source')}
      onChangeMode={(source: Source, mode: SourceMode) => { void run(async () => { await updateSource.mutateAsync({ source, changes: { mode } }); }, 'Could not change the source', 'source'); }}
      onRemove={(source) => {
        if (!window.confirm(`Remove “${source.name}” from this project?`)) return;
        void run(async () => { await deleteSource.mutateAsync(source); setNotice('Source removed.'); }, 'Could not remove the source', 'source');
      }}
      onExport={() => {
        if (!project) return;
        void run(async () => {
          const { blob, filename } = await exportProject.mutateAsync(project);
          downloadFile(filename, blob, 'application/json');
          setNotice('Project exported.');
        }, 'Could not export the project');
      }}
      onImport={(file) => {
        void run(async () => {
          if (file.size > 50 * 1024 * 1024) throw new Error('Project backup exceeds the 50 MiB limit.');
          const imported = await importProject.mutateAsync(file);
          setPickedId(imported.id);
          setNotice('Project imported as a new project.');
        }, 'Could not import the project');
      }}
    />;
  }

  if (projectsQuery.isLoading) return <LoadingScreen message="Opening projects…" />;
  if (projectsQuery.isError) return <ErrorScreen title="Projects could not be loaded" message={errorText(projectsQuery.error)} onAction={() => void projectsQuery.refetch()} />;
  return <>
    <LegacyDataNotice />
    {project
      ? <App key={project.id} project={project} projectBusy={busy} renderProjectPanel={panel} />
      : <main><h1 className="sr-only">Backlog Studio</h1>{panel(false)}<p>Create or import a project to start a backlog.</p></main>}
    {!project && <Toast notifications={notifications} />}
    {project && (notifications.error || notifications.notice) && <Toast notifications={notifications} />}
  </>;
}
