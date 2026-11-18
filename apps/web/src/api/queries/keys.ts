import type { ItemType } from '../types';

const root = ['backlog'] as const;
const projectRoot = (projectId: string) => [...root, 'project', projectId] as const;

/**
 * Query keys. Everything of one project lives under `project(id)`, so
 * `queryClient.invalidateQueries({ queryKey: backlogKeys.project(id) })` refreshes all of it (for example on an SSE `resync`).
 */
export const backlogKeys = {
  all: root,
  me: () => [...root, 'me'] as const,
  projects: () => [...root, 'projects'] as const,
  project: projectRoot,
  members: (projectId: string) => [...projectRoot(projectId), 'members'] as const,
  items: (projectId: string) => [...projectRoot(projectId), 'items'] as const,
  item: (projectId: string, itemId: string) => [...projectRoot(projectId), 'item', itemId] as const,
  revisions: (projectId: string, itemId: string) => [...projectRoot(projectId), 'item', itemId, 'revisions'] as const,
  relationships: (projectId: string) => [...projectRoot(projectId), 'relationships'] as const,
  guidance: (projectId: string) => [...projectRoot(projectId), 'guidance'] as const,
  guidanceDefaults: (projectId: string) => [...projectRoot(projectId), 'guidance', 'defaults'] as const,
  sources: (projectId: string) => [...projectRoot(projectId), 'sources'] as const,
  search: (projectId: string, kind: 'items' | 'sources', query: string) => [...projectRoot(projectId), 'search', kind, query] as const,
} as const;

export type { ItemType };
