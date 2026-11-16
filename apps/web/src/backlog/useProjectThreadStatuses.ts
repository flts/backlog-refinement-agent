import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Thread, ThreadStatus } from '../agent';
import { useAgentBackend } from '../run/AgentClientProvider';
import { agentKeys } from '../run/keys';

const priority: Record<ThreadStatus, number> = { idle: 0, running: 1, awaiting_input: 2, awaiting_review: 3 };

/** The most urgent status per item: awaiting_review > awaiting_input > running > idle. */
export function statusByItem(threads: readonly Thread[]): Map<string, ThreadStatus> {
  const result = new Map<string, ThreadStatus>();
  for (const thread of threads) {
    const current = result.get(thread.itemId);
    if (current === undefined || priority[thread.status] > priority[current]) result.set(thread.itemId, thread.status);
  }
  return result;
}

export const needsYouStatuses: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(['awaiting_input', 'awaiting_review']);

/**
 * One query for all of the current user's own threads in the project (the agent-service only lists the caller's threads),
 * reduced to a status per item. Run hooks invalidate `agentKeys.projectThreads` when a run settles, which refetches this.
 */
export function useProjectThreadStatuses(projectId: string | undefined) {
  const { threads: api } = useAgentBackend();
  const query = useQuery({
    queryKey: agentKeys.projectThreads(projectId ?? ''),
    enabled: Boolean(projectId),
    queryFn: ({ signal }) => api.list({ projectId: projectId! }, signal),
  });
  return useMemo(() => {
    const statuses = statusByItem(query.data ?? []);
    const needsInput = new Set([...statuses].filter(([, status]) => needsYouStatuses.has(status)).map(([itemId]) => itemId));
    return { statuses: statuses as ReadonlyMap<string, ThreadStatus>, needsInput: needsInput as ReadonlySet<string>, isLoading: query.isLoading };
  }, [query.data, query.isLoading]);
}
