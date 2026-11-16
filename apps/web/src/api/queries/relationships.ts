import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { unwrap } from '../client';
import type { Relationship, RelationshipType } from '../types';
import { backlogKeys } from './keys';

export function useRelationships(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.relationships(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: async () => (await unwrap(client.http.GET('/projects/{project_id}/relationships', { params: { path: { project_id: projectId! } } }))).items,
  });
}

/** The server enforces: no self links, one parent per item, no cycles, no duplicates (409 / 422). */
export function useAddRelationship(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { sourceId: string; targetId: string; type: RelationshipType }) => unwrap(client.http.POST('/projects/{project_id}/relationships', { params: { path: { project_id: projectId } }, body })),
    onSuccess: (relationship) => {
      queryClient.setQueryData<Relationship[]>(backlogKeys.relationships(projectId), (current) => current && !current.some((entry) => entry.id === relationship.id) ? [...current, relationship] : current);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.relationships(projectId) });
      if (relationship.type === 'parent-child') void queryClient.invalidateQueries({ queryKey: backlogKeys.items(projectId) });
    },
  });
}

/** Optimistic removal, restored on error. */
export function useRemoveRelationship(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (relationshipId: string) => {
      await unwrap(client.http.DELETE('/projects/{project_id}/relationships/{relationship_id}', { params: { path: { project_id: projectId, relationship_id: relationshipId } } }));
      return relationshipId;
    },
    onMutate: async (relationshipId) => {
      await queryClient.cancelQueries({ queryKey: backlogKeys.relationships(projectId) });
      const previous = queryClient.getQueryData<Relationship[]>(backlogKeys.relationships(projectId));
      queryClient.setQueryData<Relationship[]>(backlogKeys.relationships(projectId), (current) => current?.filter((entry) => entry.id !== relationshipId));
      return { previous };
    },
    onError: (_error, _id, context) => queryClient.setQueryData(backlogKeys.relationships(projectId), context?.previous),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: backlogKeys.relationships(projectId) });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.items(projectId) });
    },
  });
}
