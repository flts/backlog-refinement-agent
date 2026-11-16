/** Presence is live state, not server data, so it lives outside `backlogKeys.project(id)` and survives a wholesale invalidation. */
export const collabKeys = {
  presence: (projectId: string) => ['backlog-collab', 'presence', projectId] as const,
};
