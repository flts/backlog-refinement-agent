/** TanStack Query keys of the agent-service. */
export const agentKeys = {
  threads: (projectId: string, itemId: string) => ['agent', 'threads', projectId, itemId] as const,
};
