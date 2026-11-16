import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { requestOk } from '../client';
import type { Project } from '../types';
import { backlogKeys } from './keys';

/**
 * TODO(regenerate): `GET /projects/{id}/backup` and `POST /projects/import` (api-backup) are not in the OpenAPI snapshot yet,
 * so these use the authenticated plain `fetch`. After `pnpm api:types` has the operations, switch to `client.http`.
 */

/** Owners only. Resolves with the backup file contents (JSON, format v2) and a suggested file name. */
export function useExportProject() {
  const client = useBacklogClient();
  return useMutation({
    mutationFn: async (project: Pick<Project, 'id' | 'name'>) => {
      const response = await requestOk(client, `/projects/${encodeURIComponent(project.id)}/backup`, { headers: { Accept: 'application/json' } });
      return { blob: await response.blob(), filename: `${project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'project'}.json` };
    },
  });
}

/** Import always creates a new project owned by the importer (the server enforces the 50 MiB limit). */
export function useImportProject() {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const response = await requestOk(client, '/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file });
      return (await response.json()) as Project;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.projects() }),
  });
}
