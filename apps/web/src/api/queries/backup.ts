import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { unwrap } from '../client';
import type { BackupDocument, Project } from '../types';
import { backlogKeys } from './keys';

/** Owners only. Resolves with the backup file contents (JSON, format v2) and a suggested file name. */
export function useExportProject() {
  const client = useBacklogClient();
  return useMutation({
    mutationFn: async (project: Pick<Project, 'id' | 'name'>) => {
      const blob = await unwrap(client.http.GET('/projects/{project_id}/backup', { params: { path: { project_id: project.id } }, parseAs: 'blob' }));
      return { blob, filename: `${project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'project'}.json` };
    },
  });
}

/** Import always creates a new project owned by the importer (the server enforces the 50 MiB limit); resolves with that project. */
export function useImportProject() {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<Project> => {
      let body: BackupDocument;
      try { body = JSON.parse(await file.text()) as BackupDocument; } catch { throw new Error('The file is not valid JSON.'); }
      return (await unwrap(client.http.POST('/projects/import', { body }))).project;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.projects() }),
  });
}
