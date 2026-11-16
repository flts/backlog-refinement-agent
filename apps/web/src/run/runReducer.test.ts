import { describe, expect, it } from 'vitest';
import { createAgentClient, RunInputBuilder, type RunEvent, type RunRequest } from '../agent';
import { fakeFetch, fakeTokens, sseResponse } from '../agent/testing';
import { initialRunState, runReducer, canRetry, type RunAction, type RunState } from './runReducer';
import { parseCitations } from './citations';
import askRun from '../agent/__fixtures__/ask-user.run.json';
import askHydrate from '../agent/__fixtures__/ask-user.hydrate.json';
import askAnswer from '../agent/__fixtures__/ask-user.answer.json';
import approvalPropose from '../agent/__fixtures__/approval.propose.json';
import approvalHydrate from '../agent/__fixtures__/approval.hydrate.json';
import approvalResume from '../agent/__fixtures__/approval.resume.json';
import approvalCancel from '../agent/__fixtures__/approval.cancel.json';
import errNotFound from '../agent/__fixtures__/error.resume-not-found.json';
import errRaw from '../agent/__fixtures__/error.internal-raw-code.json';

let counter = 0;
const builder = () => new RunInputBuilder({ threadId: 'thr-1', projectId: 'p1', itemId: 'item-42', itemType: 'feature', newId: () => `id-${++counter}` });

/** Plays a recorded stream through the real client and reduces its events (preceded by `runRequested`). */
async function play(state: RunState, request: RunRequest, fixture: unknown[]): Promise<RunState> {
  const http = fakeFetch([sseResponse(fixture)]);
  const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
  let current = runReducer(state, { type: 'runRequested', request });
  await client.run(request, { onEvent: (event: RunEvent) => { current = runReducer(current, event); } });
  return current;
}

const idle = () => ({ ...initialRunState('thr-1'), phase: 'idle' as const });

describe('runReducer: lifecycle (plan §6.6)', () => {
  it('starts hydrating with a thread and idle without', () => {
    expect(initialRunState('t').phase).toBe('hydrating');
    expect(initialRunState(null).phase).toBe('idle');
  });

  it('Idle → Running → AwaitingInput: streams text, collects the ask_user and validates its arguments', async () => {
    const state = await play(idle(), builder().userMessage('Refine this feature'), askRun);
    expect(state.phase).toBe('awaitingInput');
    expect(state.messages.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(state.messages[0]).toMatchObject({ kind: 'user', text: 'Refine this feature' });
    expect(state.messages[1]).toMatchObject({ kind: 'assistant', text: 'Let me ask.', streaming: false });
    expect(state.messages[2]).toMatchObject({ kind: 'tool', toolName: 'ask_user', status: 'pending' });
    expect(state.pendingAskUser?.toolCallId).toBe('call_ask_1');
    expect(state.pendingAskUser?.args?.questions[0]).toMatchObject({ id: 'q1', header: 'Scope' });
    expect(state.runId).toBe('run-ask');
  });

  it('streams assistant text delta by delta and marks it streaming until the end', () => {
    let state = runReducer(idle(), { type: 'runStarted', threadId: 'thr-1', runId: 'r1' });
    state = runReducer(state, { type: 'textStart', messageId: 'm', role: 'assistant' });
    state = runReducer(state, { type: 'textDelta', messageId: 'm', delta: 'Hel' });
    state = runReducer(state, { type: 'textDelta', messageId: 'm', delta: 'lo' });
    expect(state.messages).toEqual([{ kind: 'assistant', id: 'm', text: 'Hello', streaming: true }]);
    state = runReducer(state, { type: 'textEnd', messageId: 'm' });
    expect(state.messages[0]).toMatchObject({ streaming: false });
  });

  it('AwaitingInput → Running → Idle: the tool-message-only answer run completes the call', async () => {
    const asked = await play(idle(), builder().userMessage('Refine this feature'), askRun);
    const request = builder().askUserAnswer('call_ask_1', { status: 'answered', answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }] });
    const running = runReducer(asked, { type: 'runRequested', request });
    expect(running.phase).toBe('running');
    expect(running.pendingAskUser).toBeUndefined();
    expect(running.messages.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'done' });
    expect(running.messages.filter((entry) => entry.kind === 'user')).toHaveLength(1);
    const done = await play(asked, request, askAnswer);
    expect(done.phase).toBe('idle');
    expect(done.messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'Thanks, scoping to admins.' });
  });

  it('shows a dismissal as a plain user message (prefix stripped) and skips the pending ask_user', async () => {
    const asked = await play(idle(), builder().userMessage('Refine'), askRun);
    const request = builder().askUserDismissedWithMessage('Just assume admins', ['q1']);
    const next = runReducer(asked, { type: 'runRequested', request });
    expect(next.messages.at(-1)).toMatchObject({ kind: 'user', text: 'Just assume admins', dismissed: true });
    expect(next.messages.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'skipped' });
    expect(next.pendingAskUser).toBeUndefined();
  });

  it('flags ask_user arguments that fail validation', () => {
    let state = runReducer(idle(), { type: 'runStarted', threadId: 'thr-1', runId: 'r1' });
    state = runReducer(state, {
      type: 'runFinished', threadId: 'thr-1', runId: 'r1', outcome: 'success', interrupts: [], pendingToolCallIds: ['c1'],
      pendingToolCalls: [{ toolCallId: 'c1', toolName: 'ask_user', argsText: '{"questions":[]}', args: { questions: [] } }],
    });
    expect(state.phase).toBe('awaitingInput');
    expect(state.pendingAskUser).toMatchObject({ toolCallId: 'c1', args: null });
  });

  it('Running → AwaitingReview: collects the interrupt and the predictive preview, keeps it until the decision', async () => {
    const state = await play(idle(), builder().userMessage('improve'), approvalPropose);
    expect(state.phase).toBe('awaitingReview');
    expect(state.interrupts).toHaveLength(1);
    expect(state.interrupts[0]).toMatchObject({ id: 'af-call-6dd7f028c7434143b100efc14e149ad9', toolCallId: 'call_prop', toolName: 'propose_document_changes' });
    expect(state.agentState.preview?.sections.map((section) => section.id)).toEqual(['s1', 's2']);
    const tool = state.messages.find((entry) => entry.kind === 'tool');
    expect(tool).toMatchObject({ toolName: 'propose_document_changes', status: 'pending' });
    expect(tool && tool.kind === 'tool' && (tool.args as { summary: string }).summary).toBe('Tighten summary + ACs');
  });

  it('AwaitingReview → Running → Idle: the server applied the resume (lastApply, no preview, result recorded)', async () => {
    const proposed = await play(idle(), builder().userMessage('improve'), approvalPropose);
    const request = builder().resume([{ interruptId: proposed.interrupts[0].id, approved: true }]);
    const running = runReducer(proposed, { type: 'runRequested', request });
    expect(running.phase).toBe('running');
    const done = await play(proposed, request, approvalResume);
    expect(done.phase).toBe('idle');
    expect(done.interrupts).toEqual([]);
    expect(done.agentState.preview).toBeNull();
    expect(done.agentState.lastApply).toMatchObject({ applied: ['s1'], newVersion: 8 });
    expect(done.messages.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'done' });
    expect(done.messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'Applied the summary change.' });
  });

  it('cancelling interrupts clears them and a cancel-only resume does not replace the retry request', async () => {
    const proposed = await play(idle(), builder().userMessage('improve'), approvalPropose);
    const original = proposed.lastRunRequest;
    const cancel = builder().resume([{ interruptId: proposed.interrupts[0].id, cancelled: true }]);
    const done = await play(proposed, cancel, approvalCancel);
    expect(done.phase).toBe('idle');
    expect(done.interrupts).toEqual([]);
    expect(done.lastRunRequest).toBe(original);
  });

  it('Hydrating → AwaitingInput (pending ask_user, restored transcript)', () => {
    const state = runReducer(initialRunState('thr-1'), { type: 'hydrated', result: hydrated('awaitingInput', askHydrate) });
    expect(state.phase).toBe('awaitingInput');
    expect(state.pendingAskUser?.toolCallId).toBe('call_ask_1');
    expect(state.messages.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(state.messages[2]).toMatchObject({ status: 'pending' });
  });

  it('Hydrating → AwaitingReview (pending interrupt, preview from state)', () => {
    const state = runReducer(initialRunState('thr-1'), { type: 'hydrated', result: hydrated('awaitingReview', approvalHydrate) });
    expect(state.phase).toBe('awaitingReview');
    expect(state.interrupts[0].toolCallId).toBe('call_prop');
    expect(state.agentState.preview?.sections).toHaveLength(2);
  });

  it('Hydrating → Idle, and Hydrating → Error with a retryable error row', () => {
    const idleState = runReducer(initialRunState('thr-1'), { type: 'hydrated', result: { status: 'idle', threadId: 'thr-1', runId: 'h', messages: [{ id: 'u1', role: 'user', content: 'hi' }], state: { preview: null }, interrupts: [], pendingAskUser: null } });
    expect(idleState.phase).toBe('idle');
    expect(idleState.messages).toEqual([{ kind: 'user', id: 'u1', text: 'hi' }]);
    const error = errorOf('INTERNAL');
    const failed = runReducer(initialRunState('thr-1'), { type: 'hydrated', result: { status: 'error', threadId: 'thr-1', runId: 'h', messages: [], state: {}, interrupts: [], pendingAskUser: null, error } });
    expect(failed.phase).toBe('error');
    expect(failed.lastError).toBe(error);
  });

  it('a dismissed question in the stored transcript is restored without the prefix and the call is skipped', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'Refine' },
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ask_user', arguments: '{}' } }] },
      { id: 'u2', role: 'user', content: '[dismissed question q1] assume admins' },
    ];
    const state = runReducer(initialRunState('thr-1'), { type: 'hydrated', result: hydrated('idle', undefined, messages) });
    expect(state.messages.map((entry) => entry.kind)).toEqual(['user', 'tool', 'user']);
    expect(state.messages[1]).toMatchObject({ status: 'skipped' });
    expect(state.messages[2]).toMatchObject({ text: 'assume admins', dismissed: true });
  });
});

describe('runReducer: errors, cancel, retry', () => {
  it('Running → Error: adds an error row, keeps the request for retry, settles open tool calls', async () => {
    const request = builder().userMessage('x');
    const state = await play(idle(), request, errRaw);
    expect(state.phase).toBe('error');
    expect(state.lastError).toMatchObject({ code: 'INTERNAL', retryable: true });
    expect(state.messages.at(-1)).toMatchObject({ kind: 'error' });
    expect(state.lastRunRequest).toBe(request);
    expect(canRetry(state)).toBe(true);
  });

  it('Error → Running (retry): the error row disappears and the user message is not duplicated', async () => {
    const request = builder().userMessage('x');
    const failed = await play(idle(), request, errRaw);
    const retry = { ...request, runId: 'new-run' };
    const running = runReducer(failed, { type: 'runRequested', request: retry });
    expect(running.phase).toBe('running');
    expect(running.lastError).toBeUndefined();
    expect(running.messages.filter((entry) => entry.kind === 'user')).toHaveLength(1);
    expect(running.messages.some((entry) => entry.kind === 'error')).toBe(false);
    expect(running.runId).toBe('new-run');
  });

  it('APPROVAL_RESUME_NOT_FOUND marks the interrupts as expired and drops the preview', async () => {
    const proposed = await play(idle(), builder().userMessage('improve'), approvalPropose);
    const failed = await play(proposed, builder().resume([{ interruptId: proposed.interrupts[0].id, approved: true }]), errNotFound);
    expect(failed.phase).toBe('error');
    expect(failed.interrupts[0]).toMatchObject({ expired: true });
    expect(failed.agentState.preview).toBeNull();
    expect(failed.lastError?.proposalExpired).toBe(true);
    expect(canRetry(failed)).toBe(true);
  });

  it('stopped: Running → Cancelled → Idle, and open tools become cancelled', () => {
    let state = runReducer(idle(), { type: 'runStarted', threadId: 'thr-1', runId: 'r' });
    state = runReducer(state, { type: 'toolCallStart', toolCallId: 'c', toolName: 'search_sources' });
    state = runReducer(state, { type: 'textStart', messageId: 'm', role: 'assistant' });
    state = runReducer(state, { type: 'stopped' });
    expect(state.phase).toBe('cancelled');
    expect(state.messages.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'cancelled' });
    expect(state.messages.find((entry) => entry.kind === 'assistant')).toMatchObject({ streaming: false });
    expect(runReducer(state, { type: 'acknowledgeCancelled' }).phase).toBe('idle');
  });

  it('a server-side cancelled run ends in Cancelled', () => {
    let state = runReducer(idle(), { type: 'runStarted', threadId: 'thr-1', runId: 'r' });
    state = runReducer(state, { type: 'runFinished', threadId: 'thr-1', runId: 'r', outcome: 'cancelled', interrupts: [], pendingToolCallIds: [], pendingToolCalls: [] });
    expect(state.phase).toBe('cancelled');
  });

  it('threadChanged resets everything', async () => {
    const proposed = await play(idle(), builder().userMessage('improve'), approvalPropose);
    expect(runReducer(proposed, { type: 'threadChanged', threadId: 'thr-2' })).toEqual(initialRunState('thr-2'));
  });
});

describe('runReducer: activity and state', () => {
  it('records steps and tool calls with their status, and ignores a failed delta', () => {
    let state = runReducer(idle(), { type: 'runStarted', threadId: 'thr-1', runId: 'r1' });
    state = runReducer(state, { type: 'stepStarted', stepName: 'Reading item' });
    state = runReducer(state, { type: 'stepFinished', stepName: 'Reading item' });
    state = runReducer(state, { type: 'toolCallStart', toolCallId: 'c1', toolName: 'get_item_context' });
    state = runReducer(state, { type: 'toolCallResult', toolCallId: 'c1', messageId: 't1', content: '{}' });
    state = runReducer(state, { type: 'toolCallStart', toolCallId: 'c2', toolName: 'find_similar_items' });
    state = runReducer(state, { type: 'toolCallResult', toolCallId: 'c2', messageId: 't2', content: 'Error: boom' });
    expect(state.activity).toMatchObject([
      { kind: 'step', name: 'Reading item', status: 'done', runId: 'r1' },
      { kind: 'tool', toolName: 'get_item_context', status: 'done' },
      { kind: 'tool', toolName: 'find_similar_items', status: 'error' },
    ]);
    const before = state.agentState;
    state = runReducer(state, { type: 'stateDelta', delta: [], state: { preview: [{ nonsense: true }] }, applied: false });
    expect(state.agentState).toBe(before);
  });

  it('parses citations of search_sources results (also MCP-wrapped)', () => {
    const passages = [{ sourceId: 's1', sourceName: 'Spec', chunkId: 'c', ordinal: 3, page: 2, headingPath: 'Intro > Scope', text: 'Admins only', score: 0.1, citationId: 'src:s1#3' }];
    expect(parseCitations(JSON.stringify({ passages }))).toMatchObject([{ citationId: 'src:s1#3', sourceName: 'Spec', page: 2, headingPath: 'Intro > Scope' }]);
    expect(parseCitations(JSON.stringify([{ type: 'text', text: JSON.stringify({ passages }) }]))).toHaveLength(1);
    expect(parseCitations('nothing')).toEqual([]);

    let state = runReducer(idle(), { type: 'toolCallStart', toolCallId: 'c', toolName: 'search_sources' });
    state = runReducer(state, { type: 'toolCallResult', toolCallId: 'c', messageId: 't', content: JSON.stringify({ passages }) });
    expect(state.activity[0]).toMatchObject({ kind: 'tool', citations: [{ citationId: 'src:s1#3' }] });
  });

  it('keeps validated nextActions and quality from state snapshots and drops invalid parts', () => {
    const state = runReducer(idle(), {
      type: 'stateSnapshot',
      state: {
        preview: null,
        nextActions: [{ id: 'a', label: 'Break down', intent: 'breakdown' }, { id: 'bad', label: 'x', intent: 'message' }],
        quality: { overall: 'ready', areas: [] },
        lastApply: { applied: [], edited: [], rejected: [], conflicted: [], newVersion: 3 },
      },
    });
    expect(state.agentState.nextActions).toEqual([{ id: 'a', label: 'Break down', intent: 'breakdown' }]);
    expect(state.agentState.quality).toMatchObject({ overall: 'ready' });
    expect(state.agentState.lastApply?.newVersion).toBe(3);
    expect(runReducer(state, { type: 'stateSnapshot', state: { preview: { sections: 'nope' } } }).agentState.preview).toBeNull();
  });
});

function errorOf(code: 'INTERNAL') {
  return { source: 'run' as const, code, key: 'internal' as const, message: 'm', retryable: true, proposalExpired: false, approvalRequired: false };
}

function hydrated(status: 'idle' | 'awaitingInput' | 'awaitingReview', fixture?: unknown[], messages?: unknown[]) {
  const events = (fixture ?? []) as { type: string; messages?: unknown[]; snapshot?: Record<string, unknown>; outcome?: { interrupts?: { id: string; toolCallId: string }[] } }[];
  const snapshot = events.find((event) => event.type === 'STATE_SNAPSHOT')?.snapshot ?? {};
  const fromEvents = events.find((event) => event.type === 'MESSAGES_SNAPSHOT')?.messages ?? [];
  const interrupts = events.find((event) => event.type === 'RUN_FINISHED')?.outcome?.interrupts ?? [];
  const msgs = (messages ?? fromEvents) as never[];
  const ask = status === 'awaitingInput' ? { toolCallId: 'call_ask_1', args: { questions: [{ id: 'q1', header: 'Scope', question: 'Which users?', options: [{ label: 'Admins' }], multiSelect: false }] } } : null;
  return {
    status, threadId: 'thr-1', runId: 'h', messages: msgs, state: { preview: null, ...snapshot },
    interrupts: interrupts.map((interrupt) => ({ id: interrupt.id, toolCallId: interrupt.toolCallId, toolName: 'propose_document_changes', args: {} })),
    pendingAskUser: ask,
  };
}

// Keeps the helper type honest: every reducer action is a known union member.
const _check: RunAction = { type: 'acknowledgeCancelled' };
void _check;
