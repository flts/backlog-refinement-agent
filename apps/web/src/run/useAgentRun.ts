import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ThreadRunQueue, type ResumeDecision } from '../agent';
import type { AgentIntent, AskUserResult, ItemType } from '../contracts';
import { useAgentBackend } from './AgentClientProvider';
import { AgentRunService, type RunResult } from './AgentRunService';
import { canRetry, initialRunState, isBusy, type RunState } from './runReducer';

export interface UseAgentRunOptions {
  projectId: string;
  itemId: string;
  itemType?: ItemType;
  /** Creates (or returns) the thread for the first message when `threadId` is undefined (`useThreads().ensureThread`). */
  ensureThread?: () => Promise<{ id: string }>;
}

const noopSubscribe = () => () => undefined;
const noThreadState = initialRunState(null);

/**
 * Binds an `AgentRunService` to React. Hydrates when a thread opens, aborts the active run when the thread, item or
 * component changes, and exposes the reducer state plus the run actions.
 */
export function useAgentRun(threadId: string | undefined, options: UseAgentRunOptions) {
  const { client } = useAgentBackend();
  const queryClient = useQueryClient();
  const { projectId, itemId, itemType } = options;
  const queue = useMemo(() => new ThreadRunQueue('reject'), []);
  const services = useRef(new Map<string, AgentRunService>());
  const ensureRef = useRef(options.ensureThread);
  ensureRef.current = options.ensureThread;
  const scope = `${projectId}/${itemId}`;

  const getService = useCallback((id: string): AgentRunService => {
    const cacheKey = `${scope}/${id}`;
    let service = services.current.get(cacheKey);
    if (!service || service.isDisposed) {
      service = new AgentRunService({ client, threadId: id, projectId, itemId, itemType, queryClient, queue });
      services.current.set(cacheKey, service);
    }
    return service;
  }, [client, scope, projectId, itemId, itemType, queryClient, queue]);

  const service = threadId ? getService(threadId) : undefined;

  useEffect(() => {
    if (!service || !threadId) return;
    services.current.set(`${scope}/${threadId}`, service);
    if (!service.started) void service.hydrate();
    return () => {
      service.detach();
      services.current.delete(`${scope}/${threadId}`);
    };
  }, [service, scope, threadId]);

  const state: RunState = useSyncExternalStore(service?.subscribe ?? noopSubscribe, service?.getState ?? (() => noThreadState));

  const serviceFor = useCallback(async (): Promise<AgentRunService | undefined> => {
    if (threadId) return getService(threadId);
    const thread = await ensureRef.current?.();
    return thread ? getService(thread.id) : undefined;
  }, [threadId, getService]);

  const busyResult: RunResult = { status: 'busy' };
  return {
    state,
    busy: isBusy(state),
    canRetry: canRetry(state),
    /** The thread the next message goes to is created on demand, so this can be undefined before the first message. */
    threadId,
    send: async (text: string, intent?: AgentIntent, childType?: ItemType): Promise<RunResult> => (await serviceFor())?.send(text, intent, childType) ?? busyResult,
    continue: async (intent: AgentIntent = 'continue', childType?: ItemType): Promise<RunResult> => (await serviceFor())?.continue(intent, childType) ?? busyResult,
    answer: (result: AskUserResult): Promise<RunResult> => service?.answer(result) ?? Promise.resolve(busyResult),
    decide: (decisions: readonly ResumeDecision[]): Promise<RunResult> => service?.decide(decisions) ?? Promise.resolve(busyResult),
    decideAll: (approved: boolean, replacements?: Record<string, Record<string, unknown>>): Promise<RunResult> => service?.decideAll(approved, replacements) ?? Promise.resolve(busyResult),
    stop: () => service?.stop(),
    repropose: (): Promise<RunResult> => service?.repropose() ?? Promise.resolve(busyResult),
    retry: (): Promise<RunResult> => service?.retry() ?? Promise.resolve(busyResult),
    acknowledgeCancelled: () => service?.acknowledgeCancelled(),
  };
}

export type AgentRun = ReturnType<typeof useAgentRun>;
