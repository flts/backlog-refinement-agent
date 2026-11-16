import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { ifMatch, requestOk, unwrap, type BacklogClient } from '../client';
import type { Source, SourceList, SourceMode } from '../types';
import { backlogKeys } from './keys';

/** While a source is waiting for or in indexing the list is refetched at this interval (fallback for a missing `source.*` event). */
export const SOURCE_POLL_INTERVAL_MS = 5000;

/** Sources plus the pinned-context budget (`pinnedBudget.used` / `limit`). Polls while any source is pending or indexing. */
export function useSources(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.sources(projectId ?? ''),
    enabled: Boolean(projectId),
    refetchInterval: (query) => query.state.data?.items.some((source) => source.indexStatus === 'pending' || source.indexStatus === 'indexing') ? SOURCE_POLL_INTERVAL_MS : false,
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/sources', { params: { path: { project_id: projectId! } } })),
  });
}

/** A source including its extracted text. */
export function useSourceText(projectId: string | undefined, sourceId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: [...backlogKeys.sources(projectId ?? ''), sourceId ?? '', 'text'] as const,
    enabled: Boolean(projectId && sourceId),
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/sources/{source_id}', { params: { path: { project_id: projectId!, source_id: sourceId! }, query: { includeText: true } } })),
  });
}

export type NewSource =
  | { kind: 'file'; file: File; name?: string; mode?: SourceMode }
  | { kind: 'url'; url: string; pastedText?: string; name?: string; mode?: SourceMode }
  | { kind: 'text'; text: string; name: string; mode?: SourceMode };

/** POST /sources: a file goes up as multipart (the original, which the server extracts and indexes), a URL or text as JSON. */
export function postSource(client: BacklogClient, projectId: string, source: NewSource): Promise<Source> {
  const params = { path: { project_id: projectId } };
  if (source.kind === 'file') {
    const form = new FormData();
    form.append('file', source.file);
    if (source.name) form.append('name', source.name);
    if (source.mode) form.append('mode', source.mode);
    // The typed body only describes the form fields; the serializer sends the real FormData (openapi-fetch sets the multipart boundary).
    return unwrap(client.http.POST('/projects/{project_id}/sources', { params, body: { file: '' }, bodySerializer: () => form }));
  }
  return unwrap(client.http.POST('/projects/{project_id}/sources', {
    params,
    body: source.kind === 'url'
      ? { url: source.url, pastedText: source.pastedText, name: source.name, mode: source.mode }
      : { text: source.text, name: source.name, mode: source.mode },
  }));
}

/**
 * A URL is fetched by the server; when that fails the error is a 422 `url-fetch-failed` and the caller can retry with `pastedText`.
 */
export function useCreateSource(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: NewSource) => postSource(client, projectId, source),
    onSuccess: (source) => {
      queryClient.setQueryData<SourceList>(backlogKeys.sources(projectId), (current) => current && !current.items.some((entry) => entry.id === source.id) ? { ...current, items: [...current.items, source] } : current);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.sources(projectId) });
    },
  });
}

/** Rename or change the mode (pinned / searchable / excluded); `source.version` is `If-Match`. Optimistic, rolled back on error. */
export function useUpdateSource(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, changes }: { source: Pick<Source, 'id' | 'version'>; changes: { name?: string; mode?: SourceMode } }) => unwrap(client.http.PATCH('/projects/{project_id}/sources/{source_id}', {
      params: { path: { project_id: projectId, source_id: source.id }, header: { 'If-Match': ifMatch(source.version) } },
      body: changes,
    })),
    onMutate: async ({ source, changes }) => {
      await queryClient.cancelQueries({ queryKey: backlogKeys.sources(projectId) });
      const previous = queryClient.getQueryData<SourceList>(backlogKeys.sources(projectId));
      queryClient.setQueryData<SourceList>(backlogKeys.sources(projectId), (current) => current && {
        ...current, items: current.items.map((entry) => entry.id === source.id ? { ...entry, ...(changes.name ? { name: changes.name } : {}), ...(changes.mode ? { mode: changes.mode } : {}) } : entry),
      });
      return { previous };
    },
    onError: (_error, _vars, context) => queryClient.setQueryData(backlogKeys.sources(projectId), context?.previous),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.sources(projectId) }),
  });
}

export function useDeleteSource(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (source: Pick<Source, 'id'> & { version?: number }) => {
      await unwrap(client.http.DELETE('/projects/{project_id}/sources/{source_id}', {
        params: { path: { project_id: projectId, source_id: source.id }, header: source.version === undefined ? {} : { 'If-Match': ifMatch(source.version) } },
      }));
      return source.id;
    },
    onSuccess: (sourceId) => {
      queryClient.setQueryData<SourceList>(backlogKeys.sources(projectId), (current) => current && { ...current, items: current.items.filter((entry) => entry.id !== sourceId) });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.sources(projectId) });
    },
  });
}

/** Queues the source for indexing again (202); the list shows it as pending until the worker is done. */
export function useReindexSource(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (source: Pick<Source, 'id'>) => {
      await unwrap(client.http.POST('/projects/{project_id}/sources/{source_id}/reindex', { params: { path: { project_id: projectId, source_id: source.id } } }));
      return source.id;
    },
    onSuccess: (sourceId) => {
      queryClient.setQueryData<SourceList>(backlogKeys.sources(projectId), (current) => current && {
        ...current, items: current.items.map((entry) => entry.id === sourceId ? { ...entry, indexStatus: 'pending', indexError: null } : entry),
      });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.sources(projectId) });
    },
  });
}

/** The original file of a source (`hasFile`) as a Blob; fetched with the bearer token, so it cannot be a plain link. */
export async function fetchSourceFile(client: BacklogClient, projectId: string, sourceId: string): Promise<Blob> {
  const response = await requestOk(client, `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/file`);
  return response.blob();
}
