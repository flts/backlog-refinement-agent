import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { unwrap } from '../client';
import type { Member, MemberRole } from '../types';
import { backlogKeys } from './keys';

export function useMembers(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.members(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: async () => (await unwrap(client.http.GET('/projects/{project_id}/members', { params: { path: { project_id: projectId! } } }))).items,
  });
}

/** Owners only. No invitation: the member has access immediately. */
export function useAddMember(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role = 'contributor' }: { email: string; role?: MemberRole }) => unwrap(client.http.POST('/projects/{project_id}/members', {
      params: { path: { project_id: projectId } }, body: { email: email.trim(), role },
    })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.members(projectId) }),
  });
}

/** Owners only; the last owner cannot be demoted (409). Optimistic, rolled back on error. */
export function useUpdateMember(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: MemberRole }) => unwrap(client.http.PATCH('/projects/{project_id}/members/{email}', {
      params: { path: { project_id: projectId, email } }, body: { role },
    })),
    onMutate: async ({ email, role }) => {
      await queryClient.cancelQueries({ queryKey: backlogKeys.members(projectId) });
      const previous = queryClient.getQueryData<Member[]>(backlogKeys.members(projectId));
      queryClient.setQueryData<Member[]>(backlogKeys.members(projectId), (current) => current?.map((member) => member.email === email ? { ...member, role } : member));
      return { previous };
    },
    onError: (_error, _vars, context) => queryClient.setQueryData(backlogKeys.members(projectId), context?.previous),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.members(projectId) }),
  });
}

/** Owners only (the last owner cannot be removed, 409). */
export function useRemoveMember(projectId: string) {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => unwrap(client.http.DELETE('/projects/{project_id}/members/{email}', { params: { path: { project_id: projectId, email } } })),
    onSuccess: (_data, email) => {
      queryClient.setQueryData<Member[]>(backlogKeys.members(projectId), (current) => current?.filter((member) => member.email !== email));
      void queryClient.invalidateQueries({ queryKey: backlogKeys.members(projectId) });
    },
  });
}

/** The signed-in user removes themselves; the project disappears from their list. The last owner cannot leave (409). */
export function useLeaveProject() {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, email }: { projectId: string; email: string }) => {
      await unwrap(client.http.DELETE('/projects/{project_id}/members/{email}', { params: { path: { project_id: projectId, email } } }));
      return projectId;
    },
    onSuccess: (projectId) => {
      queryClient.removeQueries({ queryKey: backlogKeys.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.projects() });
    },
  });
}
