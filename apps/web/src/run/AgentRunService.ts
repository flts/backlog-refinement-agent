import type { QueryClient } from '@tanstack/react-query';
import { backlogKeys } from '../api';
import {
  AgentApiError, RunInputBuilder, ThreadRunQueue, editedArgsFor, intentPrompts, sendMessageCancellingPending,
  type AgentClient, type BusyPolicy, type ResumeDecision, type RunEvent, type RunOutcome, type RunRequest,
} from '../agent';
import {
  initialAgentState, PROPOSE_CHILD_ITEMS_TOOL_NAME, PROPOSE_DOCUMENT_CHANGES_TOOL_NAME, RECORD_QUALITY_ASSESSMENT_TOOL_NAME, SET_SESSION_TITLE_TOOL_NAME,
  type AgentIntent, type AskUserResult, type ItemType,
} from '../contracts';
import { agentKeys } from './keys';
import { initialRunState, runReducer, type RunAction, type RunState } from './runReducer';

/** Tool results that mean the server changed the backlog (apply or quality write). */
export const serverWritingTools: ReadonlySet<string> = new Set([
  PROPOSE_DOCUMENT_CHANGES_TOOL_NAME, PROPOSE_CHILD_ITEMS_TOOL_NAME, RECORD_QUALITY_ASSESSMENT_TOOL_NAME,
]);

/** Refreshes everything a server-side apply can touch: the item, the item list, its revisions and the relationships. */
export function invalidateItemQueries(queryClient: QueryClient, projectId: string, itemId: string): void {
  void queryClient.invalidateQueries({ queryKey: backlogKeys.item(projectId, itemId) });
  void queryClient.invalidateQueries({ queryKey: backlogKeys.items(projectId) });
  void queryClient.invalidateQueries({ queryKey: backlogKeys.revisions(projectId, itemId) });
  void queryClient.invalidateQueries({ queryKey: backlogKeys.relationships(projectId) });
}

export type RunResult = RunOutcome | { status: 'busy' } | { status: 'cancelFailed'; cancelOutcome: RunOutcome } | { status: 'invalid'; reason: string };

export interface AgentRunServiceOptions {
  client: AgentClient;
  threadId: string;
  projectId: string;
  itemId: string;
  itemType?: ItemType;
  queryClient?: QueryClient;
  /** Share one queue per client so every service of a thread is serialised. Defaults to a private `reject` queue. */
  queue?: ThreadRunQueue;
  /** Test seam for message and run ids. */
  newId?: () => string;
}

/**
 * Orchestrates the runs of ONE thread: builds requests (`RunInputBuilder`), serialises them (`ThreadRunQueue('reject')`),
 * feeds every `RunEvent` into the pure `runReducer` and refreshes the backlog queries when the server applied something.
 * Framework independent: `useAgentRun` binds it to React with `subscribe` / `getState`.
 */
export class AgentRunService {
  private state: RunState;
  private readonly listeners = new Set<() => void>();
  private readonly builder: RunInputBuilder;
  private readonly queue: ThreadRunQueue;
  private readonly newId: () => string;
  private readonly rejectedAskUser = new Set<string>();
  private controller: AbortController | undefined;
  private wrote = false;
  private disposed = false;
  /** True once the thread was hydrated or a run was started on it (`useAgentRun` hydrates only fresh services). */
  started = false;

  constructor(private readonly options: AgentRunServiceOptions) {
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.builder = new RunInputBuilder({ threadId: options.threadId, projectId: options.projectId, itemId: options.itemId, itemType: options.itemType, newId: this.newId });
    this.queue = options.queue ?? new ThreadRunQueue('reject');
    this.state = initialRunState(options.threadId);
  }

  get threadId(): string {
    return this.options.threadId;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  matches(threadId: string, projectId: string, itemId: string): boolean {
    return !this.disposed && this.options.threadId === threadId && this.options.projectId === projectId && this.options.itemId === itemId;
  }

  getState = (): RunState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private dispatch(action: RunAction): void {
    const next = runReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Aborts the active run (thread switch, unmount). The service stays usable; an interrupted hydration is repeated on the
   * next `useAgentRun` mount. Server-side changes of a run that already applied are still refreshed.
   */
  detach(): void {
    const hydrating = this.state.phase === 'hydrating';
    this.controller?.abort();
    if (hydrating) this.started = false;
  }

  /** Aborts the active run and refuses further operations. */
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.listeners.clear();
  }

  // --- operations --------------------------------------------------------------------------------------------------

  /** Loads the stored thread (no model call): transcript, pending ask_user or pending approval. */
  async hydrate(): Promise<void> {
    // Waits for an aborted earlier hydration (React StrictMode mounts twice) instead of being refused.
    await this.exclusive(async (signal) => {
      await this.doHydrate(signal);
    }, 'queue');
  }

  /**
   * A user message. While an approval is pending the interrupts are cancelled first (spike #8); while an `ask_user`
   * is pending the message dismisses it (spike #9, `[dismissed question …]` prefix and no tool message).
   */
  send(text: string, intent?: AgentIntent, childType?: ItemType): Promise<RunResult> {
    if (!text.trim()) return Promise.resolve({ status: 'invalid', reason: 'A message must not be empty.' });
    return this.exclusive(async (signal) => {
      const { pendingAskUser, interrupts, phase } = this.state;
      const live = interrupts.filter((interrupt) => !interrupt.expired);
      let outcome: RunOutcome;
      if (live.length > 0) {
        const sent = await sendMessageCancellingPending(this.instrumented, this.builder, { text, interrupts: live, intent, childType }, { onEvent: this.onEvent }, signal);
        if (sent.status === 'cancelFailed') return sent;
        outcome = sent.outcome;
      } else if (pendingAskUser && phase === 'awaitingInput') {
        const ids = pendingAskUser.args?.questions.map((question) => question.id) ?? [];
        outcome = await this.runOne(this.builder.askUserDismissedWithMessage(text, ids, intent), signal);
      } else {
        outcome = await this.runOne(this.builder.userMessage(text, intent, childType), signal);
      }
      return this.afterRun(outcome, signal);
    });
  }

  /** An intent-only run (`/continue`, chips): sends the default prompt of the intent. */
  continue(intent: AgentIntent = 'continue', childType?: ItemType): Promise<RunResult> {
    return this.send(intentPrompts[intent], intent, childType);
  }

  /** The answer to the pending `ask_user`: ONLY the tool message (spike #10). */
  answer(result: AskUserResult): Promise<RunResult> {
    return this.exclusive(async (signal) => {
      const ask = this.state.pendingAskUser;
      if (!ask) return { status: 'invalid', reason: 'There is no pending question.' } as const;
      if (!ask.args) return this.afterRun(await this.runOne(this.builder.askUserInvalid(ask.toolCallId, ask.invalidReason ?? 'Invalid arguments.'), signal), signal);
      return this.afterRun(await this.runOne(this.builder.askUserAnswer(ask.toolCallId, result), signal), signal);
    });
  }

  /** Decisions for ALL pending interrupts; the server applies the approved parts. Use `editedArgsFor` for edits. */
  decide(decisions: readonly ResumeDecision[]): Promise<RunResult> {
    return this.exclusive(async (signal) => {
      const live = this.state.interrupts.filter((interrupt) => !interrupt.expired);
      if (live.length === 0) return { status: 'invalid', reason: 'There is no pending proposal.' } as const;
      const missing = live.filter((interrupt) => !decisions.some((decision) => decision.interruptId === interrupt.id));
      if (missing.length > 0) return { status: 'invalid', reason: 'Every pending proposal needs a decision.' } as const;
      return this.afterRun(await this.runOne(this.builder.resume(decisions), signal), signal);
    });
  }

  /** Convenience: approve (optionally with replaced argument keys) or reject every pending proposal. */
  decideAll(approved: boolean, replacements?: Record<string, Record<string, unknown>>): Promise<RunResult> {
    const decisions = this.state.interrupts.filter((interrupt) => !interrupt.expired).map((interrupt): ResumeDecision => {
      const replace = replacements?.[interrupt.id];
      return { interruptId: interrupt.id, approved, ...(approved && replace ? { editedArgs: editedArgsFor(interrupt, replace) } : {}) };
    });
    return decisions.length === 0 ? Promise.resolve({ status: 'invalid', reason: 'There is no pending proposal.' }) : this.decide(decisions);
  }

  /** Stops the active run. The state becomes `cancelled`. */
  stop(): void {
    if (this.state.phase !== 'running') return;
    this.controller?.abort();
    this.dispatch({ type: 'stopped' });
  }

  /**
   * Retries after an error with a NEW runId. The request keeps its message ids, so the transcript never shows the user
   * message twice. An expired proposal cannot be resumed: the retry asks the agent to refine again instead.
   */
  retry(): Promise<RunResult> {
    const { lastError, lastRunRequest } = this.state;
    if (lastError?.proposalExpired) return this.continue('refine');
    if (!lastRunRequest) return this.hydrate().then(() => ({ status: 'invalid', reason: 'Nothing to retry; the thread was reloaded.' }) as const);
    const request: RunRequest = { ...lastRunRequest, runId: this.newId() };
    return this.exclusive(async (signal) => this.afterRun(await this.runOne(request, signal), signal));
  }

  /** Cancelled → Idle (the composer is usable in both; this only clears the banner). */
  acknowledgeCancelled(): void {
    this.dispatch({ type: 'acknowledgeCancelled' });
  }

  // --- internals ---------------------------------------------------------------------------------------------------

  private async exclusive<T>(task: (signal: AbortSignal) => Promise<T>, policy?: BusyPolicy): Promise<T | { status: 'busy' }> {
    if (this.disposed) return { status: 'busy' };
    this.started = true;
    try {
      return await this.queue.run(this.options.threadId, async () => {
        const controller = new AbortController();
        this.controller = controller;
        this.wrote = false;
        try {
          return await task(controller.signal);
        } finally {
          if (this.controller === controller) this.controller = undefined;
          this.settled();
        }
      }, policy);
    } catch (cause) {
      if (cause instanceof AgentApiError && cause.error.source === 'local') return { status: 'busy' };
      throw cause;
    }
  }

  private async doHydrate(signal: AbortSignal): Promise<void> {
    const result = await this.options.client.hydrate(this.options.threadId, initialAgentState(this.options.projectId, this.options.itemId, this.options.itemType), signal);
    if (signal.aborted && result.status === 'error') return;
    this.dispatch({ type: 'hydrated', result });
  }

  /** The client seen by `sendMessageCancellingPending`: every request is announced to the reducer first. */
  private readonly instrumented: AgentClient = {
    run: (request, _handlers, signal) => this.runOne(request, signal),
    hydrate: (threadId, state, signal) => this.options.client.hydrate(threadId, state, signal),
    abort: () => this.options.client.abort(),
  };

  private async runOne(request: RunRequest, signal?: AbortSignal): Promise<RunOutcome> {
    this.dispatch({ type: 'runRequested', request });
    const outcome = await this.options.client.run(request, { onEvent: this.onEvent }, signal);
    if (outcome.status === 'aborted') this.dispatch({ type: 'stopped' });
    return outcome;
  }

  private onEvent = (event: RunEvent): void => {
    const before = JSON.stringify(this.state.agentState.lastApply);
    this.dispatch(event);
    if (event.type === 'toolCallResult') {
      const name = this.nameFromTranscript(event.toolCallId);
      if (name && serverWritingTools.has(name)) this.markWrite();
      if (name === SET_SESSION_TITLE_TOOL_NAME) this.invalidateThreads();
    } else if ((event.type === 'stateSnapshot' || event.type === 'stateDelta') && JSON.stringify(this.state.agentState.lastApply) !== before && this.state.agentState.lastApply) {
      this.markWrite();
    }
  };

  private nameFromTranscript(toolCallId: string): string | undefined {
    const entry = this.state.messages.find((candidate) => candidate.kind === 'tool' && candidate.id === toolCallId);
    return entry && entry.kind === 'tool' ? entry.toolName : undefined;
  }

  private markWrite(): void {
    this.wrote = true;
    if (this.options.queryClient) invalidateItemQueries(this.options.queryClient, this.options.projectId, this.options.itemId);
  }

  private invalidateThreads(): void {
    void this.options.queryClient?.invalidateQueries({ queryKey: agentKeys.projectThreads(this.options.projectId) });
  }

  /** End of an exclusive operation: one more refresh when the run wrote, and the thread list (status, title). */
  private settled(): void {
    if (this.wrote && this.options.queryClient) invalidateItemQueries(this.options.queryClient, this.options.projectId, this.options.itemId);
    this.wrote = false;
    this.invalidateThreads();
  }

  /** Follow-ups of a finished run: re-hydrate when the server still holds an approval we lost; answer an invalid ask_user once. */
  private async afterRun(outcome: RunOutcome, signal: AbortSignal): Promise<RunOutcome> {
    if (outcome.status === 'error' && outcome.error.approvalRequired) {
      await this.doHydrate(signal);
    } else if (outcome.status === 'success' && outcome.pendingAskUser && !outcome.pendingAskUser.args && !this.rejectedAskUser.has(outcome.pendingAskUser.toolCallId)) {
      const { toolCallId, invalidReason } = outcome.pendingAskUser;
      this.rejectedAskUser.add(toolCallId);
      return this.afterRun(await this.runOne(this.builder.askUserInvalid(toolCallId, invalidReason ?? 'The ask_user arguments were invalid.'), signal), signal);
    }
    return outcome;
  }
}
