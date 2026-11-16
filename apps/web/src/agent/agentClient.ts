import { HttpAgent, type AgentSubscriber, type BaseEvent } from '@ag-ui/client';
import { createAuthFetch, type TokenProvider } from '../auth';
import { initialAgentState, type AgentState } from '../contracts';
import { agentErrorFromStreamEnd, agentErrorFromThrown, isAbortError, type AgentError } from './errors';
import { findPendingClientToolCalls, pendingAskUser, RunEventMapper, type AgentStateLike, type Interrupt, type RunEvent } from './events';
import { RunInputBuilder } from './runInput';
import type { AgentClient, HydrateResult, RunHandlers, RunOutcome, RunRequest } from './types';

export interface AgentClientOptions {
  /** `api.agent` of the runtime config (for example `/api/agent`). */
  baseUrl: string;
  agentId: string;
  tokenProvider: TokenProvider;
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A stale `preview` is only meaningful while an interrupt is pending (spike #5/#6); always keep the key (null). */
function settledState(state: AgentStateLike, keepPreview: boolean): AgentStateLike {
  return keepPreview ? { preview: null, ...state } : { ...state, preview: null };
}

interface RawRun {
  mapper: RunEventMapper;
  events: RunEvent[];
  aborted: boolean;
  failure?: AgentError;
}

export function createAgentClient({ baseUrl, agentId, tokenProvider, fetch: baseFetch }: AgentClientOptions): AgentClient {
  const url = `${baseUrl.replace(/\/+$/, '')}/agents/${encodeURIComponent(agentId)}`;
  // The token is resolved per request (right before each run), so a refresh between runs is picked up; a 401 is reported
  // to the provider. In platform mode there is no token and the header is omitted.
  const authFetch = createAuthFetch(tokenProvider, baseFetch);
  const active = new Set<AbortController>();

  async function execute(input: RunRequest, emit: (event: RunEvent) => void, signal?: AbortSignal): Promise<RawRun> {
    const controller = new AbortController();
    active.add(controller);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    let retryAfter: string | null = null;
    // A new HttpAgent per run: it carries only the NEW messages, as the agent-service owns the transcript.
    const agent = new HttpAgent({
      url,
      agentId,
      threadId: input.threadId,
      initialState: input.state,
      // @ag-ui/client drops the response headers of failed requests, so keep Retry-After here.
      fetch: async (target, init) => {
        const response = await authFetch(target, init);
        retryAfter = response.headers.get('Retry-After');
        return response;
      },
    });
    for (const message of input.messages) agent.addMessage(message);

    const run: RawRun = { mapper: new RunEventMapper(input.state), events: [], aborted: false };
    const push = (event: RunEvent) => {
      run.events.push(event);
      emit(event);
    };
    let thrown: unknown;
    const subscriber: AgentSubscriber = {
      onEvent: ({ event }: { event: BaseEvent }) => {
        for (const mapped of run.mapper.map(event as unknown as { type: string })) push(mapped);
      },
      // Failures are handled below; returning stopPropagation keeps @ag-ui/client from rethrowing and console-logging them.
      onRunFailed: ({ error }) => {
        thrown = error;
        return { stopPropagation: true } as never;
      },
    };

    try {
      await agent.runAgent(
        {
          runId: input.runId,
          tools: input.tools,
          context: [],
          forwardedProps: input.forwardedProps,
          abortController: controller,
          ...(input.resume ? { resume: input.resume } : {}),
        },
        subscriber,
      );
    } catch (error) {
      thrown = error;
    } finally {
      active.delete(controller);
      signal?.removeEventListener('abort', onAbort);
    }

    if (run.mapper.failed) {
      run.failure = run.mapper.failed;
    } else if (controller.signal.aborted || (thrown !== undefined && isAbortError(thrown))) {
      run.aborted = true;
    } else if (thrown !== undefined) {
      run.failure = agentErrorFromThrown(thrown, retryAfter);
      push({ type: 'runError', runId: input.runId, code: run.failure.code, message: run.failure.serverMessage ?? run.failure.message, error: run.failure });
    } else if (!run.mapper.finished) {
      run.failure = agentErrorFromStreamEnd();
      push({ type: 'runError', runId: input.runId, code: run.failure.code, message: run.failure.message, error: run.failure });
    }
    return run;
  }

  function finishedEvent(run: RawRun): Extract<RunEvent, { type: 'runFinished' }> | undefined {
    return [...run.events].reverse().find((event): event is Extract<RunEvent, { type: 'runFinished' }> => event.type === 'runFinished');
  }

  return {
    async run(input, handlers: RunHandlers = {}, signal) {
      const run = await execute(input, (event) => handlers.onEvent?.(event), signal);
      const base = { threadId: input.threadId, runId: input.runId, messages: run.mapper.lastMessages };
      const state = run.mapper.currentState;
      if (run.failure) return { ...base, status: 'error', state, error: run.failure } satisfies RunOutcome;
      if (run.aborted) return { ...base, status: 'aborted', state } satisfies RunOutcome;
      const finished = finishedEvent(run)!;
      if (finished.outcome === 'interrupt') return { ...base, status: 'interrupt', state: settledState(state, true), interrupts: finished.interrupts } satisfies RunOutcome;
      if (finished.outcome === 'cancelled') return { ...base, status: 'cancelled', state: settledState(state, false) } satisfies RunOutcome;
      return {
        ...base,
        status: 'success',
        state: settledState(state, false),
        pendingToolCalls: finished.pendingToolCalls,
        pendingAskUser: pendingAskUser(finished.pendingToolCalls),
      } satisfies RunOutcome;
    },

    async hydrate(threadId, state: AgentState, signal) {
      const request = new RunInputBuilder({ threadId, projectId: state.projectId, itemId: state.itemId, itemType: state.itemType }).hydrate();
      const run = await execute({ ...request, state: { ...initialAgentState(state.projectId, state.itemId, state.itemType) } }, () => undefined, signal);
      const messages = run.mapper.lastMessages ?? [];
      const runId = request.runId;
      if (run.failure || run.aborted) {
        const error = run.failure ?? agentErrorFromThrown(new DOMException('Aborted', 'AbortError'));
        return { status: 'error', threadId, runId, messages, state: run.mapper.currentState, interrupts: [], pendingAskUser: null, error } satisfies HydrateResult;
      }
      const finished = finishedEvent(run)!;
      const interrupts: Interrupt[] = finished.outcome === 'interrupt' ? finished.interrupts : [];
      if (interrupts.length > 0) {
        return { status: 'awaitingReview', threadId, runId, messages, state: settledState(run.mapper.currentState, true), interrupts, pendingAskUser: null } satisfies HydrateResult;
      }
      const ask = pendingAskUser(findPendingClientToolCalls(messages));
      return {
        status: ask ? 'awaitingInput' : 'idle',
        threadId,
        runId,
        messages,
        state: settledState(run.mapper.currentState, false),
        interrupts: [],
        pendingAskUser: ask,
      } satisfies HydrateResult;
    },

    abort() {
      for (const controller of [...active]) controller.abort();
    },
  };
}
