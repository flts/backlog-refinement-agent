import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { ifMatch, unwrap, type BacklogClient } from '../client';
import type { Source, SourceList, SourceMode } from '../types';
import { backlogKeys } from './keys';

/** Sources plus the pinned-context budget (`pinnedBudget.used` / `limit`). */
export function useSources(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.sources(projectId ?? ''),
    enabled: Boolean(projectId),
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
