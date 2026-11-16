import { useState, type FormEvent } from 'react';
import { isVersionConflict, useDeleteProject, useProject, useRenameProject, type Project } from '../api';
import { errorText } from '../app/useNotifications';

export function GeneralSection({ project, isOwner, onDeleted }: { project: Project; isOwner: boolean; onDeleted: () => void }) {
  const projectQuery = useProject(project.id);
  const current = projectQuery.data ?? project;
  const rename = useRenameProject();
  const remove = useDeleteProject();
  const [name, setName] = useState<string>();
  const [confirmName, setConfirmName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const value = name ?? current.name;
  const canRename = isOwner && value.trim().length > 0 && value.trim() !== current.name && !rename.isPending;

  function submitRename(event: FormEvent) {
    event.preventDefault();
    setError(''); setMessage(''); setConflict(false);
    rename.mutate({ project: current, name: value }, {
      onSuccess: () => { setName(undefined); setMessage('Project renamed.'); },
      onError: (cause) => { if (isVersionConflict(cause)) setConflict(true); else setError(`Could not rename the project: ${errorText(cause)}`); },
    });
  }

  function submitDelete(event: FormEvent) {
    event.preventDefault();
    setDeleteError('');
    remove.mutate(current, {
      onSuccess: onDeleted,
      onError: (cause) => {
        if (isVersionConflict(cause)) { setDeleteError('Someone else changed this project. Reload to see their changes, then delete again.'); void projectQuery.refetch(); }
        else setDeleteError(`Could not delete the project: ${errorText(cause)}`);
      },
    });
  }

  return <>
    <h3>General</h3>
    <form className="settings-block" onSubmit={submitRename} noValidate>
      <label htmlFor="project-name">Project name</label>
      <div className="settings-inline">
        <input id="project-name" value={value} maxLength={200} readOnly={!isOwner} aria-describedby={isOwner ? undefined : 'settings-readonly-note'}
          onChange={(event) => { setName(event.target.value); setMessage(''); }} />
        {isOwner && <button type="submit" className="button button-primary button-small" disabled={!canRename}>{rename.isPending ? 'Renaming…' : 'Rename'}</button>}
      </div>
      <p className="settings-help">Your role: {current.role === 'owner' ? 'owner' : 'contributor'}.</p>
      {conflict && <div className="guidance-issues" role="alert">
        <p><strong>Someone else changed this project.</strong> Reload to see their changes before renaming.</p>
        <button type="button" className="button button-secondary button-small" onClick={() => { void projectQuery.refetch(); setConflict(false); setName(undefined); }}>Reload</button>
      </div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <p className="guidance-meta" role="status">{message}</p>
    </form>
    {isOwner && <form className="settings-block danger-zone" onSubmit={submitDelete}>
      <h4>Delete project</h4>
      <p className="settings-help">Deletes “{current.name}” with all its sources, backlog items, relationships and guidance for every member. This cannot be undone.</p>
      <label htmlFor="delete-confirm">Type the project name to confirm</label>
      <div className="settings-inline">
        <input id="delete-confirm" value={confirmName} autoComplete="off" onChange={(event) => setConfirmName(event.target.value)} />
        <button type="submit" className="button button-danger button-small" disabled={confirmName !== current.name || remove.isPending}>{remove.isPending ? 'Deleting…' : 'Delete project'}</button>
      </div>
      {deleteError && <p className="field-error" role="alert">{deleteError}</p>}
    </form>}
  </>;
}
