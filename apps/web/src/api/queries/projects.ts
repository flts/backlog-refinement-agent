import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { ifMatch, unwrap } from '../client';
import type { Project } from '../types';
import { backlogKeys } from './keys';

export function useProjects() {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.projects(),
    queryFn: async () => (await unwrap(client.http.GET('/projects'))).items,
  });
}

export function useProject(projectId: string | undefined) {
  const client = useBacklogClient();
  return useQuery({
    queryKey: backlogKeys.project(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: () => unwrap(client.http.GET('/projects/{project_id}', { params: { path: { project_id: projectId! } } })),
  });
}

function putProject(queryClient: QueryClient, project: Project) {
  queryClient.setQueryData<Project[]>(backlogKeys.projects(), (current) => current?.map((entry) => entry.id === project.id ? project : entry));
}

export function useCreateProject() {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => unwrap(client.http.POST('/projects', { body: { name: name.trim() } })),
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(backlogKeys.projects(), (current) => current ? [...current, project] : current);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.projects() });
    },
  });
}

/** Owners only. `project.version` is sent as `If-Match`; a stale version rejects with `ConflictError`. */
export function useRenameProject() {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ project, name }: { project: Pick<Project, 'id' | 'version'>; name: string }) => unwrap(client.http.PATCH('/projects/{project_id}', {
      params: { path: { project_id: project.id }, header: { 'If-Match': ifMatch(project.version) } },
      body: { name: name.trim() },
    })),
    onSuccess: (project) => { putProject(queryClient, project); queryClient.setQueryData(backlogKeys.project(project.id), project); },
    onError: () => void queryClient.invalidateQueries({ queryKey: backlogKeys.projects() }),
  });
}

/** Owners only; deletes the project with everything in it. */
export function useDeleteProject() {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (project: Pick<Project, 'id' | 'version'>) => {
      await unwrap(client.http.DELETE('/projects/{project_id}', {
        params: { path: { project_id: project.id }, header: { 'If-Match': ifMatch(project.version) } },
      }));
      return project.id;
    },
    onSuccess: (projectId) => {
      queryClient.setQueryData<Project[]>(backlogKeys.projects(), (current) => current?.filter((entry) => entry.id !== projectId));
      queryClient.removeQueries({ queryKey: backlogKeys.project(projectId) });
    },
  });
}
