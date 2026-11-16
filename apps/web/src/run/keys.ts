/** TanStack Query keys of the agent-service. */
export const agentKeys = {
  /** All of the user's own threads in a project; a prefix of `threads`, so invalidating it refreshes both. */
  projectThreads: (projectId: string) => ['agent', 'threads', projectId] as const,
  threads: (projectId: string, itemId: string) => ['agent', 'threads', projectId, itemId] as const,
};
