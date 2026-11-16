import type { Message, Tool } from '@ag-ui/core';
import type { AgentState, ForwardedProps, ResumeEntry } from '../contracts';
import type { AgentError } from './errors';
import type { AgentStateLike, Interrupt, PendingAskUser, PendingToolCall, RunEvent } from './events';

/** One AG-UI run request (`RunAgentInput` without the transport details). Build it with `RunInputBuilder`. */
export interface RunRequest {
  threadId: string;
  runId: string;
  /** Only the NEW messages. The agent-service holds the transcript; `[]` without `resume` is a hydrate. */
  messages: Message[];
  state: AgentState;
  tools: Tool[];
  /** `{}` when there is no intent. */
  forwardedProps: ForwardedProps | Record<string, never>;
  resume?: ResumeEntry[];
}

export interface RunHandlers {
  /** Called for every mapped event, in order, including the synthetic `runError` for transport failures. */
  onEvent?: (event: RunEvent) => void;
}

interface OutcomeBase {
  threadId: string;
  runId: string;
  /** Local copy of the shared state after the run (`preview` is null again when no interrupt is pending). */
  state: AgentStateLike;
  /** Last MESSAGES_SNAPSHOT of the run, when there was one. */
  messages?: Message[];
}

export type RunOutcome =
  | (OutcomeBase & {
      status: 'success';
      /** Unanswered client tool calls (`ask_user`); empty when the agent simply finished. */
      pendingToolCalls: PendingToolCall[];
      /** The pending `ask_user`, when there is one (spike #10: it is a success outcome, not an interrupt). */
      pendingAskUser: PendingAskUser | null;
    })
  | (OutcomeBase & { status: 'interrupt'; interrupts: Interrupt[] })
  /** The server reported `outcome: cancelled`. */
  | (OutcomeBase & { status: 'cancelled' })
  /** The caller aborted (signal or `abort()`); the stream stopped without RUN_FINISHED. */
  | (OutcomeBase & { status: 'aborted' })
  | (OutcomeBase & { status: 'error'; error: AgentError });

export type HydrateStatus = 'idle' | 'awaitingInput' | 'awaitingReview';

export type HydrateResult =
  | {
      status: HydrateStatus;
      threadId: string;
      runId: string;
      /** AG-UI transcript (MESSAGES_SNAPSHOT). */
      messages: Message[];
      /** Shared state; `preview` is null unless an interrupt is pending (a stale preview after cancel is dropped). */
      state: AgentStateLike;
      interrupts: Interrupt[];
      pendingAskUser: PendingAskUser | null;
      error?: undefined;
    }
  | { status: 'error'; threadId: string; runId: string; messages: Message[]; state: AgentStateLike; interrupts: Interrupt[]; pendingAskUser: null; error: AgentError };

export interface AgentClient {
  /** Runs one request and resolves with its outcome; never rejects (errors become `status: 'error'`). */
  run(input: RunRequest, handlers?: RunHandlers, signal?: AbortSignal): Promise<RunOutcome>;
  /** Replays the stored thread (no model call): transcript, state, pending interrupt or pending ask_user. */
  hydrate(threadId: string, state: AgentState, signal?: AbortSignal): Promise<HydrateResult>;
  /** Aborts every active run of this client. */
  abort(): void;
}
