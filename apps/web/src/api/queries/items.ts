import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { ifMatch, unwrap } from '../client';
import { isVersionConflict } from '../errors';
import type { Item, ItemChanges, ItemSummary, ItemType } from '../types';
import { backlogKeys } from './keys';

/** Flat list (tree-friendly: every entry has `parentId`) without documents. */
export function useItems(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.items(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: async () => (await unwrap(client.http.GET('/projects/{project_id}/items', { params: { path: { project_id: projectId! } } }))).items,
  });
}

/** One item with its document; `version` is the ETag to send as `If-Match` when saving. */
export function useItem(projectId: string | undefined, itemId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.item(projectId ?? '', itemId ?? ''),
    enabled: Boolean(projectId && itemId),
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/items/{item_id}', { params: { path: { project_id: projectId!, item_id: itemId! } } })),
  });
}

function summarize(item: Item, previous?: ItemSummary): ItemSummary {
  return {
    id: item.id, parentId: item.parentId, type: item.type, title: item.title, status: item.status, version: item.version,
    quality: item.quality ? { overall: (item.quality.assessment as { overall?: ItemSummary['quality'] extends infer Q ? (Q extends { overall: infer O } ? O : never) : never }).overall ?? null, assessedAt: item.quality.assessedAt, stale: item.quality.stale } : previous?.quality ?? null,
    updatedAt: item.updatedAt, updatedBy: item.updatedBy,
  };
}

/** Writes a server item into the item cache and into the list entry (without a refetch). */
export function cacheItem(queryClient: QueryClient, item: Item) {
  queryClient.setQueryData(backlogKeys.item(item.projectId, item.id), item);
  queryClient.setQueryData<ItemSummary[]>(backlogKeys.items(item.projectId), (current) => {
    if (!current) return current;
    return current.some((entry) => entry.id === item.id)
      ? current.map((entry) => entry.id === item.id ? summarize(item, entry) : entry)
      : [...current, summarize(item)];
  });
}

/** The server creates the document from the project's effective template; send only the type, optional title and parent. */
export function useCreateItem(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, title, parentId }: { type: ItemType; title?: string; parentId?: string }) => unwrap(client.http.POST('/projects/{project_id}/items', {
      params: { path: { project_id: projectId } },
      body: { type, title: title?.trim() || undefined, parentId },
    })),
    onSuccess: (item) => {
      cacheItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.items(projectId) });
      if (item.parentId) void queryClient.invalidateQueries({ queryKey: backlogKeys.relationships(projectId) });
    },
  });
}

export interface UpdateItemVariables {
  /** The item as last seen; its `version` becomes `If-Match`. */
  item: Pick<Item, 'id' | 'version'>;
  changes: ItemChanges;
}

/**
 * Saves title/document/status with `If-Match: <version>`. A stale version rejects with `ConflictError`
 * (`currentVersion`, `changedSections`, `item`); the item cache is then refreshed with the server's current item.
 * A no-op change (nothing differs) returns the unchanged item.
 */
export function useUpdateItem(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ item, changes }: UpdateItemVariables) => unwrap(client.http.PATCH('/projects/{project_id}/items/{item_id}', {
      params: { path: { project_id: projectId, item_id: item.id }, header: { 'If-Match': ifMatch(item.version) } },
      body: changes,
    })),
    onSuccess: (item) => {
      cacheItem(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.revisions(projectId, item.id) });
    },
    onError: (error, { item }) => {
      if (isVersionConflict(error) && error.item) cacheItem(queryClient, error.item);
      else void queryClient.invalidateQueries({ queryKey: backlogKeys.item(projectId, item.id) });
    },
  });
}

/** Status transitions are validated by the server (422 `invalid-status-transition`). Optimistic, rolled back on error. */
export function useChangeItemStatus(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ item, status }: { item: Pick<Item, 'id' | 'version'>; status: Item['status'] }) => unwrap(client.http.PATCH('/projects/{project_id}/items/{item_id}', {
      params: { path: { project_id: projectId, item_id: item.id }, header: { 'If-Match': ifMatch(item.version) } },
      body: { status },
    })),
    onMutate: async ({ item, status }) => {
      await queryClient.cancelQueries({ queryKey: backlogKeys.item(projectId, item.id) });
      const previous = queryClient.getQueryData<Item>(backlogKeys.item(projectId, item.id));
      if (previous) queryClient.setQueryData<Item>(backlogKeys.item(projectId, item.id), { ...previous, status });
      return { previous };
    },
    onSuccess: (item) => cacheItem(queryClient, item),
    onError: (error, { item }, context) => {
      if (isVersionConflict(error) && error.item) cacheItem(queryClient, error.item);
      else if (context?.previous) cacheItem(queryClient, context.previous);
      else void queryClient.invalidateQueries({ queryKey: backlogKeys.item(projectId, item.id) });
    },
  });
}

/** Deletes the item with its relationships; related items are kept. `item.version` is sent as `If-Match` when known. */
export function useDeleteItem(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: Pick<Item, 'id'> & { version?: number }) => {
      await unwrap(client.http.DELETE('/projects/{project_id}/items/{item_id}', {
        params: { path: { project_id: projectId, item_id: item.id }, header: item.version === undefined ? {} : { 'If-Match': ifMatch(item.version) } },
      }));
      return item.id;
    },
    onSuccess: (itemId) => {
      queryClient.removeQueries({ queryKey: backlogKeys.item(projectId, itemId) });
      queryClient.setQueryData<ItemSummary[]>(backlogKeys.items(projectId), (current) => current?.filter((entry) => entry.id !== itemId));
      void queryClient.invalidateQueries({ queryKey: backlogKeys.items(projectId) });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.relationships(projectId) });
    },
  });
}
