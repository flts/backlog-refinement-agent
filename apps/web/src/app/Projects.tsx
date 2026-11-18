import { useEffect, useState } from 'react';
import {
  isVersionConflict, useCreateProject, useDeleteProject, useImportProject, useProjects, useRenameProject,
} from '../api';
import { ShareDialog } from '../collab/ShareDialog';
import App from './App';
import { LegacyDataNotice } from './LegacyDataNotice';
import { EmptyTopbar, type ProjectControls } from '../shell';
import { Toast } from './Toast';
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
  const notifications = useNotifications();
  const [sharing, setSharing] = useState(false);
  const { setError, setNotice, report } = notifications;

  const createProject = useCreateProject();
  const renameProject = useRenameProject();
  const deleteProject = useDeleteProject();
  const importProject = useImportProject();
  const busy = [createProject, renameProject, deleteProject, importProject].some((mutation) => mutation.isPending);

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

  const controls: ProjectControls = {
    projects, busy,
    onSelect: (next) => { if (!busy) setPickedId(next); },
    onCreate: (name) => run(async () => {
      const created = await createProject.mutateAsync(name);
      setPickedId(created.id);
      setNotice('Project created.');
    }),
    onRename: (name) => run(async () => {
      if (!project) throw new Error('Choose a project first.');
      await renameProject.mutateAsync({ project, name });
      setNotice('Project renamed.');
    }, 'Could not rename the project'),
    onDelete: () => {
      if (!project || !window.confirm(`Delete “${project.name}” and all its sources, backlog items and relationships?`)) return;
      void run(async () => { await deleteProject.mutateAsync(project); setPickedId(undefined); setNotice('Project deleted.'); }, 'Could not delete the project');
    },
    onImport: (file) => {
      void run(async () => {
        if (file.size > 50 * 1024 * 1024) throw new Error('Project backup exceeds the 50 MiB limit.');
        const imported = await importProject.mutateAsync(file);
        setPickedId(imported.id);
        setNotice('Project imported as a new project.');
      }, 'Could not import the project');
    },
  };

  if (projectsQuery.isLoading) return <LoadingScreen message="Opening projects…" />;
  if (projectsQuery.isError) return <ErrorScreen title="Projects could not be loaded" message={errorText(projectsQuery.error)} onAction={() => void projectsQuery.refetch()} />;
  return <>
    <LegacyDataNotice />
    {project
      ? <App key={project.id} project={project} projectBusy={busy} projectControls={controls} onOpenShare={() => setSharing(true)} onProjectGone={(_reason, message) => { setSharing(false); setNotice(message); void projectsQuery.refetch(); }} />
      : <><EmptyTopbar controls={controls} /><main className="empty-projects"><h1 className="sr-only">Backlog Studio</h1><p>Create or import a project to start a backlog.</p></main></>}
    {project && sharing && <ShareDialog project={project} onClose={() => setSharing(false)} onNotice={(text) => setNotice(text)} />}
    {!project && <Toast notifications={notifications} />}
    {project && (notifications.error || notifications.notice) && <Toast notifications={notifications} />}
  </>;
}
