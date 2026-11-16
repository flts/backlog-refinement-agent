import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { ifMatch, unwrap } from '../client';
import { isVersionConflict } from '../errors';
import type { Item } from '../types';
import { cacheItem } from './items';
import { backlogKeys } from './keys';

/** Newest first. Each entry carries origin (`manual` | `agent` | `restore`), actor and run id. */
export function useRevisions(projectId: string | undefined, itemId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.revisions(projectId ?? '', itemId ?? ''),
    enabled: Boolean(projectId && itemId),
    queryFn: async () => (await unwrap(client.http.GET('/projects/{project_id}/items/{item_id}/revisions', { params: { path: { project_id: projectId!, item_id: itemId! } } }))).items,
  });
}

/** One revision including its title and document (for compare). */
export function useRevision(projectId: string | undefined, itemId: string | undefined, revisionId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: [...backlogKeys.revisions(projectId ?? '', itemId ?? ''), revisionId ?? ''] as const,
    enabled: Boolean(projectId && itemId && revisionId),
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/items/{item_id}/revisions/{revision_id}', { params: { path: { project_id: projectId!, item_id: itemId!, revision_id: revisionId! } } })),
  });
}

/** Restores a revision as a new version. Pass the item's `version` to fail with `ConflictError` when it changed meanwhile. */
export function useRestoreRevision(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ item, revisionId }: { item: Pick<Item, 'id'> & { version?: number }; revisionId: string }) => unwrap(client.http.POST('/projects/{project_id}/items/{item_id}/revisions/{revision_id}/restore', {
      params: { path: { project_id: projectId, item_id: item.id, revision_id: revisionId }, header: item.version === undefined ? {} : { 'If-Match': ifMatch(item.version) } },
    })),
    onSuccess: (item) => {
      cacheItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.revisions(projectId, item.id) });
    },
    onError: (error, { item }) => {
      if (isVersionConflict(error)) void queryClient.invalidateQueries({ queryKey: backlogKeys.item(projectId, item.id) });
    },
  });
}
