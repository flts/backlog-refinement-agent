import type { Message } from '@ag-ui/core';
import jsonpatch, { type Operation } from 'fast-json-patch';
import { AgentStateSchema, ASK_USER_TOOL_NAME, AskUserArgsSchema, type AgentState, type AskUserArgs } from '../contracts';
import { agentErrorFromRunError, type AgentError } from './errors';

/** A pending approval (`RUN_FINISHED outcome=interrupt`). Answer it with `RunInputBuilder.resume`. */
export interface Interrupt {
  /** `interrupt.id` ("af-call-..."). This, not `toolCallId`, goes into `resume[].interruptId`. */
  id: string;
  toolCallId: string;
  toolName: string;
  /** Original tool arguments from `metadata.agent_framework.function_call.arguments` (spike #2). */
  args: Record<string, unknown>;
  message?: string;
  responseSchema?: unknown;
}

/** A client tool call the run left for the SPA to answer (`ask_user`). */
export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  argsText: string;
  /** Parsed JSON arguments, or `undefined` when they are not valid JSON. */
  args: unknown;
}

export interface PendingAskUser {
  toolCallId: string;
  /** Validated arguments, or `null` when invalid; answer with `RunInputBuilder.askUserInvalid` then. */
  args: AskUserArgs | null;
  /** Why `args` is null. */
  invalidReason?: string;
}

export type RunFinishedOutcome = 'success' | 'interrupt' | 'cancelled';

export type RunEvent =
  | { type: 'runStarted'; threadId: string; runId: string }
  | { type: 'textStart'; messageId: string; role: string }
  | { type: 'textDelta'; messageId: string; delta: string }
  | { type: 'textEnd'; messageId: string }
  | { type: 'toolCallStart'; toolCallId: string; toolName: string; parentMessageId?: string }
  | { type: 'toolCallArgs'; toolCallId: string; delta: string }
  | { type: 'toolCallEnd'; toolCallId: string }
  | { type: 'toolCallResult'; toolCallId: string; messageId: string; content: string }
  /** `state` is not schema-validated (see `readAgentState`). */
  | { type: 'stateSnapshot'; state: AgentStateLike }
  /** `state` is the local copy after applying `delta`; `applied` is false when the patch could not be applied. */
  | { type: 'stateDelta'; delta: Operation[]; state: AgentStateLike; applied: boolean }
  | { type: 'messagesSnapshot'; messages: Message[] }
  | { type: 'stepStarted'; stepName: string }
  | { type: 'stepFinished'; stepName: string }
  | {
      type: 'runFinished';
      threadId: string;
      runId: string;
      outcome: RunFinishedOutcome;
      interrupts: Interrupt[];
      pendingToolCallIds: string[];
      pendingToolCalls: PendingToolCall[];
    }
  | { type: 'runError'; runId: string; code: AgentError['code']; message: string; error: AgentError };

export type AgentStateLike = Record<string, unknown>;

/** Validates the shared state; the predictive `preview` shape is only trusted after this. */
export function readAgentState(state: unknown): { ok: true; state: AgentState } | { ok: false; error: string } {
  const parsed = AgentStateSchema.safeParse(state);
  return parsed.success ? { ok: true, state: parsed.data } : { ok: false, error: parsed.error.message };
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  return JSON.stringify(content ?? '');
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

interface RawEvent {
  type: string;
  [key: string]: unknown;
}

interface TrackedCall {
  name: string;
  argsText: string;
  hasResult: boolean;
}

/**
 * Turns raw AG-UI events into `RunEvent`s and keeps what a run outcome needs: a local state copy (JSON patch applied,
 * initialised from the request state so `preview: null` exists), the tool calls started in this run and the last
 * MESSAGES_SNAPSHOT. Pure (no I/O) so it can be tested with captured event sequences.
 */
export class RunEventMapper {
  private state: AgentStateLike;
  private messages: Message[] | undefined;
  private readonly calls = new Map<string, TrackedCall>();
  private runId = '';
  private threadId = '';
  finished = false;
  failed: AgentError | undefined;

  constructor(initialState: AgentStateLike) {
    this.state = clone(initialState);
  }

  get currentState(): AgentStateLike {
    return this.state;
  }

  get lastMessages(): Message[] | undefined {
    return this.messages;
  }

  map(event: RawEvent): RunEvent[] {
    switch (event.type) {
      case 'RUN_STARTED':
        this.threadId = String(event.threadId ?? '');
        this.runId = String(event.runId ?? '');
        return [{ type: 'runStarted', threadId: this.threadId, runId: this.runId }];
      case 'TEXT_MESSAGE_START':
        return [{ type: 'textStart', messageId: String(event.messageId), role: String(event.role ?? 'assistant') }];
      case 'TEXT_MESSAGE_CONTENT':
        return [{ type: 'textDelta', messageId: String(event.messageId), delta: String(event.delta ?? '') }];
      case 'TEXT_MESSAGE_END':
        return [{ type: 'textEnd', messageId: String(event.messageId) }];
      case 'TOOL_CALL_START': {
        const toolCallId = String(event.toolCallId);
        const toolName = String(event.toolCallName);
        this.calls.set(toolCallId, { name: toolName, argsText: '', hasResult: false });
        return [{ type: 'toolCallStart', toolCallId, toolName, ...(event.parentMessageId ? { parentMessageId: String(event.parentMessageId) } : {}) }];
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = String(event.toolCallId);
        const delta = String(event.delta ?? '');
        const call = this.calls.get(toolCallId);
        if (call) call.argsText += delta;
        return [{ type: 'toolCallArgs', toolCallId, delta }];
      }
      case 'TOOL_CALL_END':
        return [{ type: 'toolCallEnd', toolCallId: String(event.toolCallId) }];
      case 'TOOL_CALL_RESULT': {
        const toolCallId = String(event.toolCallId);
        const call = this.calls.get(toolCallId);
        if (call) call.hasResult = true;
        return [{ type: 'toolCallResult', toolCallId, messageId: String(event.messageId ?? ''), content: contentText(event.content) }];
      }
      case 'STATE_SNAPSHOT':
        this.state = clone(asRecord(event.snapshot) ?? {});
        return [{ type: 'stateSnapshot', state: this.state }];
      case 'STATE_DELTA': {
        const delta = (Array.isArray(event.delta) ? event.delta : []) as Operation[];
        const applied = this.applyDelta(delta);
        return [{ type: 'stateDelta', delta, state: this.state, applied }];
      }
      case 'MESSAGES_SNAPSHOT':
        this.messages = clone((Array.isArray(event.messages) ? event.messages : []) as Message[]);
        return [{ type: 'messagesSnapshot', messages: this.messages }];
      case 'STEP_STARTED':
        return [{ type: 'stepStarted', stepName: String(event.stepName) }];
      case 'STEP_FINISHED':
        return [{ type: 'stepFinished', stepName: String(event.stepName) }];
      case 'RUN_FINISHED':
        this.finished = true;
        return [this.mapRunFinished(event)];
      case 'RUN_ERROR': {
        this.finished = true;
        const runId = String(event.runId ?? this.runId);
        const error = agentErrorFromRunError({ code: event.code, message: event.message, runId });
        this.failed = error;
        return [{ type: 'runError', runId, code: error.code, message: error.serverMessage ?? error.message, error }];
      }
      default:
        // CUSTOM (PredictState, usage, function_approval_request), RAW, REASONING_*: not needed by the UI.
        return [];
    }
  }

  private applyDelta(delta: Operation[]): boolean {
    const attempt = (operations: Operation[]): boolean => {
      try {
        this.state = jsonpatch.applyPatch(clone(this.state), operations, true, false).newDocument as AgentStateLike;
        return true;
      } catch {
        return false;
      }
    };
    if (attempt(delta)) return true;
    // `replace` on a key that does not exist yet (for example /preview when it was never initialised) fails; `add` sets it.
    return attempt(delta.map((operation) => (operation.op === 'replace' ? ({ ...operation, op: 'add' } as Operation) : operation)));
  }

  private pendingCalls(ids?: readonly string[]): PendingToolCall[] {
    const wanted = ids ?? [...this.calls].filter(([, call]) => !call.hasResult).map(([id]) => id);
    return wanted.map((toolCallId) => {
      const call = this.calls.get(toolCallId);
      return { toolCallId, toolName: call?.name ?? '', argsText: call?.argsText ?? '', args: parseJson(call?.argsText ?? '') };
    });
  }

  private mapRunFinished(event: RawEvent): RunEvent {
    const outcome = asRecord(event.outcome);
    const type = outcome?.type === 'interrupt' || outcome?.type === 'cancelled' ? outcome.type : 'success';
    const interrupts = type === 'interrupt' ? this.mapInterrupts(outcome?.interrupts) : [];
    let pendingToolCallIds: string[] = [];
    if (type === 'success') {
      const named = Array.isArray(outcome?.pendingToolCallIds) ? (outcome.pendingToolCallIds as unknown[]).map(String) : [];
      pendingToolCallIds = named.length > 0 ? named : this.pendingCalls().map((call) => call.toolCallId);
    }
    return {
      type: 'runFinished',
      threadId: String(event.threadId ?? this.threadId),
      runId: String(event.runId ?? this.runId),
      outcome: type,
      interrupts,
      pendingToolCallIds,
      pendingToolCalls: this.pendingCalls(pendingToolCallIds),
    };
  }

  private mapInterrupts(raw: unknown): Interrupt[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): Interrupt[] => {
      const entry = asRecord(item);
      if (!entry || typeof entry.id !== 'string') return [];
      const call = asRecord(asRecord(asRecord(entry.metadata)?.agent_framework)?.function_call);
      const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : typeof call?.call_id === 'string' ? call.call_id : '';
      const tracked = this.calls.get(toolCallId);
      const rawArgs = call?.arguments;
      const args = asRecord(typeof rawArgs === 'string' ? parseJson(rawArgs) : rawArgs) ?? asRecord(parseJson(tracked?.argsText ?? '')) ?? {};
      return [
        {
          id: entry.id,
          toolCallId,
          toolName: typeof call?.name === 'string' ? call.name : (tracked?.name ?? ''),
          args: clone(args),
          ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
          ...(entry.responseSchema !== undefined ? { responseSchema: entry.responseSchema } : {}),
        },
      ];
    });
  }
}

/** Client tool calls (`ask_user`) in a transcript that no later tool message answered; used after hydration (spike #10). */
export function findPendingClientToolCalls(messages: readonly Message[]): PendingToolCall[] {
  const open = new Map<string, PendingToolCall>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        if (call.function.name !== ASK_USER_TOOL_NAME) continue;
        open.set(call.id, { toolCallId: call.id, toolName: call.function.name, argsText: call.function.arguments, args: parseJson(call.function.arguments) });
      }
    } else if (message.role === 'tool') {
      open.delete(message.toolCallId);
    } else if (message.role === 'user' && open.size > 0) {
      // A user message after an unanswered call is a dismissal: the server injects a synthetic result.
      open.clear();
    }
  }
  return [...open.values()];
}

/** The pending `ask_user` among the given tool calls (the last one wins; the agent asks at most once per turn). */
export function pendingAskUser(calls: readonly PendingToolCall[]): PendingAskUser | null {
  const call = [...calls].reverse().find((candidate) => candidate.toolName === ASK_USER_TOOL_NAME);
  if (!call) return null;
  const parsed = AskUserArgsSchema.safeParse(call.args);
  if (parsed.success) return { toolCallId: call.toolCallId, args: parsed.data };
  return { toolCallId: call.toolCallId, args: null, invalidReason: call.args === undefined ? 'The arguments are not valid JSON.' : parsed.error.message };
}
