import { useQuery } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { unwrap } from '../client';
import type { components } from '../backlog.schema';
import { backlogKeys } from './keys';

export type SearchResults = components['schemas']['SearchResults'];
export type SearchKind = 'items' | 'sources';

/**
 * `GET /projects/{id}/search?q=&kind=`: semantic (vector + full-text) search over items or source passages.
 * `semantic: false` in the answer means only full-text contributed. Disabled for an empty query.
 */
export function useProjectSearch(projectId: string | undefined, query: string, kind: SearchKind, options: { enabled?: boolean; limit?: number } = {}) {
  const client = useBacklogClient();
  const q = query.trim();
  return useQuery({
    queryKey: backlogKeys.search(projectId ?? '', kind, q),
    enabled: Boolean(projectId) && q.length > 0 && (options.enabled ?? true),
    staleTime: 30_000,
    retry: false,
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}/search', { params: { path: { project_id: projectId! }, query: { q, kind, limit: options.limit } } })),
  });
}
