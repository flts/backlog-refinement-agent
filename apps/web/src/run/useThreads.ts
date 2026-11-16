import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { FeedbackRating, Thread } from '../agent';
import { useAgentBackend } from './AgentClientProvider';
import { agentKeys } from './keys';

const byRecency = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * The agent threads (refinement sessions) of one item. The newest thread is active until the user picks another one.
 * `ensureThread` creates the first thread lazily, on the first message.
 */
export function useThreads(projectId: string | undefined, itemId: string | undefined) {
  const { threads: api } = useAgentBackend();
  const queryClient = useQueryClient();
  const key = agentKeys.threads(projectId ?? '', itemId ?? '');
  const enabled = Boolean(projectId && itemId);
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async ({ signal }) => (await api.list({ projectId: projectId!, itemId: itemId! }, signal)).sort(byRecency),
  });
  const threads = useMemo(() => query.data ?? [], [query.data]);
  const [picked, setPicked] = useState<{ itemId?: string; threadId?: string }>({});
  const pickedId = picked.itemId === itemId ? picked.threadId : undefined;
  const activeThreadId = threads.some((thread) => thread.id === pickedId) ? pickedId : threads[0]?.id;

  const createMutation = useMutation({
    mutationFn: (title?: string) => api.create({ projectId: projectId!, itemId: itemId!, ...(title ? { title } : {}) }),
    onSuccess: (thread) => {
      queryClient.setQueryData<Thread[]>(key, (current) => [thread, ...(current ?? []).filter((entry) => entry.id !== thread.id)]);
      setPicked({ itemId, threadId: thread.id });
    },
  });
  const renameMutation = useMutation({
    mutationFn: ({ threadId, title }: { threadId: string; title: string }) => api.rename(threadId, title),
    onSuccess: (thread) => queryClient.setQueryData<Thread[]>(key, (current) => (current ?? []).map((entry) => (entry.id === thread.id ? thread : entry))),
  });
  const removeMutation = useMutation({
    mutationFn: (threadId: string) => api.remove(threadId),
    onSuccess: (_void, threadId) => {
      queryClient.setQueryData<Thread[]>(key, (current) => (current ?? []).filter((entry) => entry.id !== threadId));
      void queryClient.invalidateQueries({ queryKey: agentKeys.projectThreads(projectId ?? '') });
    },
  });

  const feedbackMutation = useMutation({
    mutationFn: (input: { threadId: string; messageId: string; rating: FeedbackRating; comment?: string }) => api.feedback(input),
  });

  const selectThread = useCallback((threadId: string) => setPicked({ itemId, threadId }), [itemId]);

  /** The active thread, or a newly created one when the item has none yet. */
  const ensureThread = useCallback(async (): Promise<Thread> => {
    if (!enabled) throw new Error('Select an item first.');
    const existing: Thread[] = queryClient.getQueryData<Thread[]>(key) ?? (await queryClient.fetchQuery({ queryKey: key, queryFn: async () => (await api.list({ projectId: projectId!, itemId: itemId! })).sort(byRecency) }));
    const current = existing.find((thread) => thread.id === activeThreadId) ?? existing[0];
    if (current) return current;
    return createMutation.mutateAsync(undefined);
  }, [enabled, queryClient, key, api, projectId, itemId, activeThreadId, createMutation]);

  return {
    threads,
    activeThreadId,
    isLoading: query.isLoading,
    error: query.error,
    selectThread,
    ensureThread,
    create: (title?: string) => createMutation.mutateAsync(title),
    rename: (threadId: string, title: string) => renameMutation.mutateAsync({ threadId, title }),
    remove: (threadId: string) => removeMutation.mutateAsync(threadId),
    /** Rates an assistant message (thumbs up/down with an optional comment); the service keeps one rating per message. */
    feedback: (input: { threadId: string; messageId: string; rating: FeedbackRating; comment?: string }) => feedbackMutation.mutateAsync(input),
    refetch: query.refetch,
  };
}

export type Threads = ReturnType<typeof useThreads>;
