import type { Message } from '@ag-ui/core';
import {
  AgentStateSchema, ASK_USER_TOOL_NAME, LastApplySchema, NextActionSchema, StateQualitySchema,
  type ChildPreview, type DocumentPreview, type LastApply, type NextAction, type StateQuality,
} from '../contracts';
import type { AgentError, HydrateResult, Interrupt, PendingAskUser, RunEvent, RunRequest } from '../agent';
import { findPendingClientToolCalls, pendingAskUser as pickPendingAskUser } from '../agent';
import { parseCitations, SEARCH_SOURCES_TOOL_NAME, type Citation } from './citations';

export type RunPhase = 'hydrating' | 'idle' | 'running' | 'awaitingInput' | 'awaitingReview' | 'error' | 'cancelled';

export type ToolStatus = 'running' | 'pending' | 'done' | 'error' | 'skipped' | 'cancelled';

export type TranscriptEntry =
  /** `dismissed`: the user typed a message instead of answering `ask_user` (the `[dismissed question …]` prefix is stripped from `text`). */
  | { kind: 'user'; id: string; text: string; dismissed?: boolean }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  /** `pending`: the call ended without a result because it waits for the user (`ask_user`, an approval). */
  | { kind: 'tool'; id: string; toolName: string; argsText: string; args?: unknown; result?: string; status: ToolStatus }
  | { kind: 'step'; id: string; name: string; status: 'running' | 'done' }
  | { kind: 'error'; id: string; error: AgentError };

export type ActivityEntry =
  | { kind: 'step'; id: string; runId: string; name: string; status: 'running' | 'done' }
  | { kind: 'tool'; id: string; runId: string; toolName: string; status: ToolStatus; args?: unknown; citations: Citation[] };

/** An approval the user must decide on. `expired`: the server lost it (restart) and answered APPROVAL_RESUME_NOT_FOUND. */
export type ReviewInterrupt = Interrupt & { expired?: boolean };

/** The validated parts of the shared AG-UI state the UI uses. Invalid parts are dropped, never half-trusted. */
export interface AgentStateView {
  preview: DocumentPreview | null;
  childPreview: ChildPreview | null;
  nextActions: NextAction[];
  quality: StateQuality | null;
  lastApply: LastApply | null;
}

export interface RunState {
  phase: RunPhase;
  threadId: string | null;
  runId?: string;
  messages: TranscriptEntry[];
  activity: ActivityEntry[];
  pendingAskUser?: PendingAskUser;
  interrupts: ReviewInterrupt[];
  agentState: AgentStateView;
  lastError?: AgentError;
  /** The last request that started a model run (not a cancel-only resume); `retry` re-sends it with a new runId. */
  lastRunRequest?: RunRequest;
  /** Internal counter for deterministic ids. */
  seq: number;
}

export type RunAction =
  | RunEvent
  | { type: 'threadChanged'; threadId: string | null }
  | { type: 'hydrated'; result: HydrateResult }
  /** A run is about to start (send, answer, dismissal, decide, retry): shows the user message, clears the error. */
  | { type: 'runRequested'; request: RunRequest }
  /** The pending interrupts were cancelled (cancel-then-message flow). */
  | { type: 'interruptsCleared' }
  /** The user stopped the run. */
  | { type: 'stopped' }
  /** Cancelled → Idle. */
  | { type: 'acknowledgeCancelled' };

export const emptyAgentState: AgentStateView = { preview: null, childPreview: null, nextActions: [], quality: null, lastApply: null };

export function initialRunState(threadId: string | null): RunState {
  return { phase: threadId ? 'hydrating' : 'idle', threadId, messages: [], activity: [], interrupts: [], agentState: emptyAgentState, seq: 0 };
}

const dismissedPrefix = /^\[dismissed question[^\]]*\]\s*/;

/** Reads the parts of a raw AG-UI state; keys that are absent keep the previous value (except the previews). */
export function viewOfState(raw: Record<string, unknown>, previous: AgentStateView = emptyAgentState): AgentStateView {
  const shape = AgentStateSchema.shape;
  // The spike streams the sections array itself; the contract wraps it in `{sections}`. Accept both.
  const preview = shape.preview.safeParse(Array.isArray(raw.preview) ? { sections: raw.preview } : (raw.preview ?? null));
  const childPreview = shape.childPreview.safeParse(raw.childPreview ?? null);
  const nextActions = Array.isArray(raw.nextActions)
    ? raw.nextActions.flatMap((action): NextAction[] => { const parsed = NextActionSchema.safeParse(action); return parsed.success ? [parsed.data] : []; }).slice(0, 3)
    : previous.nextActions;
  const quality = 'quality' in raw ? StateQualitySchema.nullable().safeParse(raw.quality) : undefined;
  const lastApply = 'lastApply' in raw ? LastApplySchema.nullable().safeParse(raw.lastApply) : undefined;
  return {
    preview: preview.success ? preview.data : null,
    childPreview: childPreview.success ? (childPreview.data ?? null) : null,
    nextActions,
    quality: quality ? (quality.success ? quality.data : null) : previous.quality,
    lastApply: lastApply ? (lastApply.success ? lastApply.data : null) : previous.lastApply,
  };
}

const looksLikeToolError = (content: string) => /^Error\b/i.test(content.trim());

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  return '';
}

function userEntry(id: string, content: unknown): TranscriptEntry {
  const raw = messageText(content);
  const dismissed = dismissedPrefix.test(raw);
  return { kind: 'user', id, text: dismissed ? raw.replace(dismissedPrefix, '') : raw, ...(dismissed ? { dismissed: true } : {}) };
}

/** Rebuilds the transcript from a stored AG-UI thread (hydration). Pending client tool calls (`ask_user`) stay `pending`. */
export function transcriptFromMessages(messages: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const pendingIds = new Set(findPendingClientToolCalls(messages).map((call) => call.toolCallId));
  const byCall = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>();
  for (const message of messages) {
    if (message.role === 'user') {
      entries.push(userEntry(message.id, message.content));
    } else if (message.role === 'assistant') {
      const text = messageText(message.content);
      if (text) entries.push({ kind: 'assistant', id: message.id, text, streaming: false });
      for (const call of message.toolCalls ?? []) {
        const entry: Extract<TranscriptEntry, { kind: 'tool' }> = {
          kind: 'tool', id: call.id, toolName: call.function.name, argsText: call.function.arguments, args: parseJson(call.function.arguments),
          status: pendingIds.has(call.id) ? 'pending' : 'running',
        };
        byCall.set(call.id, entry);
        entries.push(entry);
      }
    } else if (message.role === 'tool') {
      const entry = byCall.get(message.toolCallId);
      if (entry) {
        entry.result = messageText(message.content);
        entry.status = message.error || looksLikeToolError(entry.result) ? 'error' : 'done';
      }
    }
  }
  // A call without result that is not waiting for the user was answered by the server (skipped after a dismissal) or is an approval.
  for (const entry of byCall.values()) if (entry.status === 'running') entry.status = entry.toolName === ASK_USER_TOOL_NAME ? 'skipped' : 'pending';
  return entries;
}

function mapTool(state: RunState, toolCallId: string, update: (entry: Extract<TranscriptEntry, { kind: 'tool' }>) => Extract<TranscriptEntry, { kind: 'tool' }>): RunState {
  if (!state.messages.some((entry) => entry.kind === 'tool' && entry.id === toolCallId)) return state;
  return { ...state, messages: state.messages.map((entry) => (entry.kind === 'tool' && entry.id === toolCallId ? update(entry) : entry)) };
}

function mapActivityTool(state: RunState, toolCallId: string, update: (entry: Extract<ActivityEntry, { kind: 'tool' }>) => Extract<ActivityEntry, { kind: 'tool' }>): RunState {
  return { ...state, activity: state.activity.map((entry) => (entry.kind === 'tool' && entry.id === toolCallId ? update(entry) : entry)) };
}

function finalizeStreaming(messages: TranscriptEntry[]): TranscriptEntry[] {
  return messages.map((entry) => (entry.kind === 'assistant' && entry.streaming ? { ...entry, streaming: false } : entry));
}

/** Settles everything that still looks active when a run ends: `running` tools/steps become `settledTool`/done. */
function settle(state: RunState, settledTool: (id: string) => ToolStatus): RunState {
  return {
    ...state,
    messages: finalizeStreaming(state.messages).map((entry) => {
      if (entry.kind === 'tool' && entry.status === 'running') return { ...entry, status: settledTool(entry.id) };
      if (entry.kind === 'step' && entry.status === 'running') return { ...entry, status: 'done' };
      return entry;
    }),
    activity: state.activity.map((entry) => {
      if (entry.kind === 'tool' && entry.status === 'running') return { ...entry, status: settledTool(entry.id) };
      if (entry.kind === 'step' && entry.status === 'running') return { ...entry, status: 'done' };
      return entry;
    }),
  };
}

function trimTrailingErrors(messages: TranscriptEntry[]): TranscriptEntry[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].kind === 'error') end -= 1;
  return end === messages.length ? messages : messages.slice(0, end);
}

const isCancelOnly = (request: RunRequest) => (request.resume?.length ?? 0) > 0 && request.resume!.every((entry) => entry.status === 'cancelled');

function reduceRunRequested(state: RunState, request: RunRequest): RunState {
  let messages = trimTrailingErrors(state.messages);
  let pending = state.pendingAskUser;
  for (const message of request.messages) {
    if (message.role === 'user' && !messages.some((entry) => entry.kind === 'user' && entry.id === message.id)) messages = [...messages, userEntry(message.id, message.content)];
    if (message.role === 'tool') {
      const content = messageText(message.content);
      messages = messages.map((entry) => (entry.kind === 'tool' && entry.id === message.toolCallId ? { ...entry, result: content, status: message.error ? 'error' : 'done' } : entry));
      if (pending?.toolCallId === message.toolCallId) pending = undefined;
    }
  }
  if (pending && request.messages.some((message) => message.role === 'user')) {
    const skipped = pending.toolCallId;
    messages = messages.map((entry) => (entry.kind === 'tool' && entry.id === skipped ? { ...entry, status: 'skipped' } : entry));
    pending = undefined;
  }
  return {
    ...state,
    phase: 'running',
    runId: request.runId,
    messages,
    pendingAskUser: pending,
    interrupts: state.interrupts.filter((interrupt) => !interrupt.expired),
    lastError: undefined,
    lastRunRequest: isCancelOnly(request) ? state.lastRunRequest : request,
    agentState: { ...state.agentState, nextActions: [] },
  };
}

function reduceHydrated(state: RunState, result: HydrateResult): RunState {
  const base: RunState = {
    ...state,
    runId: result.runId,
    messages: transcriptFromMessages(result.messages),
    activity: [],
    interrupts: result.interrupts,
    pendingAskUser: result.pendingAskUser ?? undefined,
    agentState: viewOfState(result.state),
    lastError: undefined,
  };
  switch (result.status) {
    case 'awaitingInput': return { ...base, phase: 'awaitingInput' };
    case 'awaitingReview': return { ...base, phase: 'awaitingReview' };
    case 'error': return { ...base, phase: 'error', lastError: result.error, messages: [...base.messages, { kind: 'error', id: `error:${state.seq}`, error: result.error }], seq: state.seq + 1 };
    default: return { ...base, phase: 'idle' };
  }
}

function reduceFinished(state: RunState, event: Extract<RunEvent, { type: 'runFinished' }>): RunState {
  const waiting = new Set([...event.interrupts.map((interrupt) => interrupt.toolCallId), ...event.pendingToolCalls.map((call) => call.toolCallId)]);
  const settled = settle(state, (id) => (waiting.has(id) ? 'pending' : 'done'));
  if (event.outcome === 'interrupt') {
    return { ...settled, phase: 'awaitingReview', interrupts: event.interrupts, pendingAskUser: undefined };
  }
  const agentState = { ...settled.agentState, preview: null, childPreview: null };
  if (event.outcome === 'cancelled') return { ...settled, phase: 'cancelled', interrupts: [], pendingAskUser: undefined, agentState };
  const ask = pickPendingAskUser(event.pendingToolCalls);
  return { ...settled, phase: ask ? 'awaitingInput' : 'idle', interrupts: [], pendingAskUser: ask ?? undefined, agentState };
}

function reduceError(state: RunState, event: Extract<RunEvent, { type: 'runError' }>): RunState {
  const settled = settle(state, () => 'error');
  const error = event.error;
  const expire = error.proposalExpired;
  return {
    ...settled,
    phase: 'error',
    lastError: error,
    interrupts: expire ? settled.interrupts.map((interrupt) => ({ ...interrupt, expired: true })) : settled.interrupts,
    agentState: expire ? { ...settled.agentState, preview: null, childPreview: null } : settled.agentState,
    messages: [...settled.messages, { kind: 'error', id: `error:${state.seq}`, error }],
    seq: state.seq + 1,
  };
}

/** Pure run-state machine (plan §6.6). Deterministic: no clocks, no random ids. */
export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'threadChanged':
      return initialRunState(action.threadId);
    case 'hydrated':
      return reduceHydrated(state, action.result);
    case 'runRequested':
      return reduceRunRequested(state, action.request);
    case 'interruptsCleared':
      return { ...state, interrupts: [], agentState: { ...state.agentState, preview: null, childPreview: null } };
    case 'stopped': {
      const settled = settle(state, () => 'cancelled');
      return { ...settled, phase: 'cancelled' };
    }
    case 'acknowledgeCancelled':
      return state.phase === 'cancelled' ? { ...state, phase: 'idle' } : state;

    case 'runStarted':
      return { ...state, phase: 'running', runId: action.runId };
    case 'textStart': {
      if (action.role !== 'assistant') return state;
      if (state.messages.some((entry) => entry.kind === 'assistant' && entry.id === action.messageId)) {
        return { ...state, messages: state.messages.map((entry) => (entry.kind === 'assistant' && entry.id === action.messageId ? { ...entry, streaming: true } : entry)) };
      }
      return { ...state, messages: [...state.messages, { kind: 'assistant', id: action.messageId, text: '', streaming: true }] };
    }
    case 'textDelta': {
      const exists = state.messages.some((entry) => entry.kind === 'assistant' && entry.id === action.messageId);
      if (!exists) return { ...state, messages: [...state.messages, { kind: 'assistant', id: action.messageId, text: action.delta, streaming: true }] };
      return { ...state, messages: state.messages.map((entry) => (entry.kind === 'assistant' && entry.id === action.messageId ? { ...entry, text: entry.text + action.delta } : entry)) };
    }
    case 'textEnd':
      return { ...state, messages: state.messages.map((entry) => (entry.kind === 'assistant' && entry.id === action.messageId ? { ...entry, streaming: false } : entry)) };
    case 'toolCallStart': {
      if (state.messages.some((entry) => entry.kind === 'tool' && entry.id === action.toolCallId)) return mapTool(state, action.toolCallId, (entry) => ({ ...entry, status: 'running' }));
      return {
        ...state,
        messages: [...state.messages, { kind: 'tool', id: action.toolCallId, toolName: action.toolName, argsText: '', status: 'running' }],
        activity: [...state.activity, { kind: 'tool', id: action.toolCallId, runId: state.runId ?? '', toolName: action.toolName, status: 'running', citations: [] }],
      };
    }
    case 'toolCallArgs': {
      const next = mapTool(state, action.toolCallId, (entry) => {
        const argsText = entry.argsText + action.delta;
        return { ...entry, argsText, args: parseJson(argsText) };
      });
      const entry = next.messages.find((candidate) => candidate.kind === 'tool' && candidate.id === action.toolCallId);
      return entry && entry.kind === 'tool' ? mapActivityTool(next, action.toolCallId, (activity) => ({ ...activity, args: entry.args })) : next;
    }
    case 'toolCallEnd':
      return state;
    case 'toolCallResult': {
      const status: ToolStatus = looksLikeToolError(action.content) ? 'error' : 'done';
      const known = state.messages.find((entry) => entry.kind === 'tool' && entry.id === action.toolCallId);
      const next = mapTool(state, action.toolCallId, (entry) => ({ ...entry, result: action.content, status }));
      const toolName = known && known.kind === 'tool' ? known.toolName : '';
      return mapActivityTool(next, action.toolCallId, (entry) => ({
        ...entry, status, citations: toolName === SEARCH_SOURCES_TOOL_NAME && status === 'done' ? parseCitations(action.content) : entry.citations,
      }));
    }
    case 'stateSnapshot':
      return { ...state, agentState: viewOfState(action.state, state.agentState) };
    case 'stateDelta':
      return action.applied ? { ...state, agentState: viewOfState(action.state, state.agentState) } : state;
    case 'messagesSnapshot': {
      const authoritative = new Map(action.messages.filter((message) => message.role === 'assistant').map((message) => [message.id, messageText(message.content)]));
      return {
        ...state,
        messages: state.messages.map((entry) => {
          if (entry.kind !== 'assistant') return entry;
          const text = authoritative.get(entry.id);
          return text ? { ...entry, text, streaming: false } : entry;
        }),
      };
    }
    case 'stepStarted':
      return {
        ...state,
        messages: [...state.messages, { kind: 'step', id: `step:${state.seq}`, name: action.stepName, status: 'running' }],
        activity: [...state.activity, { kind: 'step', id: `step:${state.seq}`, runId: state.runId ?? '', name: action.stepName, status: 'running' }],
        seq: state.seq + 1,
      };
    case 'stepFinished': {
      const target = [...state.activity].reverse().find((entry) => entry.kind === 'step' && entry.name === action.stepName && entry.status === 'running');
      if (!target) return state;
      return {
        ...state,
        messages: state.messages.map((entry) => (entry.kind === 'step' && entry.id === target.id ? { ...entry, status: 'done' } : entry)),
        activity: state.activity.map((entry) => (entry.kind === 'step' && entry.id === target.id ? { ...entry, status: 'done' } : entry)),
      };
    }
    case 'runFinished':
      return reduceFinished(state, action);
    case 'runError':
      return reduceError(state, action);
    default:
      return state;
  }
}

/** Derived flags for the UI. */
export function isBusy(state: RunState): boolean {
  return state.phase === 'running' || state.phase === 'hydrating';
}

export function canRetry(state: RunState): boolean {
  return state.phase === 'error' && Boolean(state.lastError && (state.lastError.retryable || state.lastError.proposalExpired));
}
