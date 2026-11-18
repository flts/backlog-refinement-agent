import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from './agentClient';
import type { RunEvent } from './events';
import { RunInputBuilder } from './runInput';
import { fakeFetch, fakeTokens, problemResponse, sseResponse } from './testing';
import askRun from './__fixtures__/ask-user.run.json';
import askHydrate from './__fixtures__/ask-user.hydrate.json';
import askAnswer from './__fixtures__/ask-user.answer.json';
import approvalPropose from './__fixtures__/approval.propose.json';
import approvalHydrate from './__fixtures__/approval.hydrate.json';
import approvalResume from './__fixtures__/approval.resume.json';
import approvalCancel from './__fixtures__/approval.cancel.json';
import errNotFound from './__fixtures__/error.resume-not-found.json';
import errRequired from './__fixtures__/error.resume-required.json';
import errRaw from './__fixtures__/error.internal-raw-code.json';

const builder = (ids = 0) => {
  let n = ids;
  return new RunInputBuilder({ threadId: 'thr-1', projectId: 'p1', itemId: 'item-42', itemType: 'feature', newId: () => `id-${++n}` });
};

function setup(responses: Response[] | Parameters<typeof fakeFetch>[0], tokens: Parameters<typeof fakeTokens>[0] = 'token-1') {
  const http = fakeFetch(responses);
  const provider = fakeTokens(tokens);
  const client = createAgentClient({ baseUrl: '/api/agent/', agentId: 'backlog-refiner', tokenProvider: provider, fetch: http.fetch });
  return { client, http, provider };
}

const types = (events: RunEvent[]) => events.map((event) => event.type);

describe('agent client: ask_user (spike out_q1, out_ts_e2e)', () => {
  it('maps the stream and reports the pending ask_user of a success outcome', async () => {
    const { client, http } = setup([sseResponse(askRun)]);
    const events: RunEvent[] = [];
    const outcome = await client.run(builder().userMessage('Refine this feature'), { onEvent: (event) => events.push(event) });

    expect(types(events)).toEqual([
      'runStarted', 'textStart', 'textDelta', 'toolCallStart', ...Array(events.filter((e) => e.type === 'toolCallArgs').length).fill('toolCallArgs'), 'toolCallEnd', 'textEnd', 'messagesSnapshot', 'runFinished',
    ]);
    expect(events.filter((e) => e.type === 'toolCallArgs').length).toBeGreaterThan(2);
    expect(events[3]).toMatchObject({ type: 'toolCallStart', toolCallId: 'call_ask_1', toolName: 'ask_user' });
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') return;
    expect(outcome.pendingToolCalls.map((call) => call.toolCallId)).toEqual(['call_ask_1']);
    expect(outcome.pendingAskUser?.toolCallId).toBe('call_ask_1');
    expect(outcome.pendingAskUser?.args?.questions[0]).toMatchObject({ id: 'q1', header: 'Scope', multiSelect: false });
    expect(outcome.state).toMatchObject({ projectId: 'p1', itemId: 'item-42', preview: null });

    // request shape
    const request = http.requests[0];
    expect(request.url).toBe('/api/agent/agents/backlog-refiner');
    expect(request.method).toBe('POST');
    expect(request.headers.get('accept')).toBe('text/event-stream');
    expect(request.body).toMatchObject({
      threadId: 'thr-1',
      runId: 'id-2',
      messages: [{ id: 'id-1', role: 'user', content: 'Refine this feature' }],
      state: { schemaVersion: 1, projectId: 'p1', itemId: 'item-42', itemType: 'feature', preview: null },
      context: [],
      forwardedProps: {},
    });
    expect((request.body as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['ask_user']);
    expect((request.body as { resume?: unknown }).resume).toBeUndefined();
  });

  it('declares ask_user with the shared JSON schema as parameters', async () => {
    const { client, http } = setup([sseResponse(askRun)]);
    await client.run(builder().userMessage('x'));
    const tool = (http.requests[0].body as { tools: { name: string; description: string; parameters: Record<string, unknown> }[] }).tools[0];
    expect(tool.description).toMatch(/1-3 clarifying questions/);
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['questions'], additionalProperties: false });
    expect(tool.parameters.$schema).toBeUndefined();
  });

  it('sends only the tool message for the answer run (no user message)', async () => {
    const { client, http } = setup([sseResponse(askAnswer)]);
    const b = builder();
    const request = b.askUserAnswer('call_ask_1', { status: 'answered', answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }] });
    const outcome = await client.run(request);
    expect(outcome).toMatchObject({ status: 'success', pendingToolCalls: [], pendingAskUser: null });
    const sent = http.requests[0].body as { messages: { role: string; toolCallId?: string; content: string }[] };
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]).toMatchObject({ role: 'tool', toolCallId: 'call_ask_1' });
    expect(JSON.parse(sent.messages[0].content)).toMatchObject({ status: 'answered' });
  });

  it('hydrates a pending ask_user from the last assistant toolCalls without a tool result (spike #10)', async () => {
    const { client, http } = setup([sseResponse(askHydrate)]);
    const result = await client.hydrate('thr-1', { schemaVersion: 1, projectId: 'p1', itemId: 'item-42', preview: null });
    expect(result.status).toBe('awaitingInput');
    expect(result.pendingAskUser?.toolCallId).toBe('call_ask_1');
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    const sent = http.requests[0].body as { messages: unknown[]; resume?: unknown; tools: unknown[] };
    expect(sent.messages).toEqual([]);
    expect(sent.resume).toBeUndefined();
    expect(sent.tools).toEqual([]);
  });
});

describe('agent client: approvals (spike out_q5_per_request, out_ts_e2e)', () => {
  it('reports an interrupt with id, toolCallId and parsed args, and applies the preview delta onto preview: null', async () => {
    const { client } = setup([sseResponse(approvalPropose)]);
    const events: RunEvent[] = [];
    const outcome = await client.run(builder().userMessage('improve'), { onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('interrupt');
    if (outcome.status !== 'interrupt') return;
    expect(outcome.interrupts).toHaveLength(1);
    const [interrupt] = outcome.interrupts;
    expect(interrupt).toMatchObject({ id: 'af-call-6dd7f028c7434143b100efc14e149ad9', toolCallId: 'call_prop', toolName: 'propose_document_changes' });
    expect(interrupt.args).toMatchObject({ summary: 'Tighten summary + ACs', base_version: 7 });
    expect((interrupt.args.sections as unknown[]).length).toBe(2);
    expect(interrupt.responseSchema).toBeDefined();
    expect(outcome.state.preview).toHaveLength(2);

    const delta = events.find((event) => event.type === 'stateDelta');
    expect(delta).toMatchObject({ applied: true });
    expect((delta as Extract<RunEvent, { type: 'stateDelta' }>).state.preview).toHaveLength(2);
    expect(types(events).at(-1)).toBe('runFinished');
  });

  it('applies a replace delta even when the client state had no preview key', async () => {
    const { client } = setup([sseResponse(approvalPropose.filter((e) => e.type !== 'STATE_SNAPSHOT'))]);
    const request = { ...builder().userMessage('improve'), state: { schemaVersion: 1 as const, projectId: 'p1', itemId: 'item-42' } as never };
    const events: RunEvent[] = [];
    await client.run(request, { onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'stateDelta')).toMatchObject({ applied: true });
  });

  it('hydrates a pending interrupt without a model call', async () => {
    const { client } = setup([sseResponse(approvalHydrate)]);
    const result = await client.hydrate('thr-1', { schemaVersion: 1, projectId: 'p1', itemId: 'item-42', preview: null });
    expect(result.status).toBe('awaitingReview');
    expect(result.interrupts[0]).toMatchObject({ id: 'af-call-6dd7f028c7434143b100efc14e149ad9', toolCallId: 'call_prop' });
    expect(result.state.preview).toHaveLength(2);
    expect(result.messages).toHaveLength(3);
  });

  it('sends the resume payload with a full-replacement editedArgs and returns to idle with preview null', async () => {
    const { client, http } = setup([sseResponse(approvalResume)]);
    const b = builder();
    const interruptArgs = { summary: 'Tighten summary + ACs', base_version: 7, sections: [{ id: 's1' }, { id: 's2' }] };
    const edited = { ...interruptArgs, sections: [{ id: 's1', heading: 'Summary', mode: 'replace', markdown: 'User-edited summary' }] };
    const outcome = await client.run(b.resume([{ interruptId: 'af-call-6dd7f028c7434143b100efc14e149ad9', approved: true, editedArgs: edited }]));

    expect(http.requests[0].body).toMatchObject({
      messages: [],
      resume: [{ interruptId: 'af-call-6dd7f028c7434143b100efc14e149ad9', status: 'resolved', payload: { approved: true, editedArgs: edited } }],
    });
    expect(outcome).toMatchObject({ status: 'success', pendingToolCalls: [] });
    if (outcome.status !== 'success') return;
    expect(outcome.state.preview).toBeNull();
    expect(outcome.state.lastApply).toMatchObject({ applied: ['s1'], newVersion: 8 });
  });

  it('cancels a pending interrupt with a cancelled resume entry (no payload)', async () => {
    const { client, http } = setup([sseResponse(approvalCancel)]);
    const outcome = await client.run(builder().resume([{ interruptId: 'af-x', cancelled: true }]));
    expect(outcome.status).toBe('success');
    expect(http.requests[0].body).toMatchObject({ resume: [{ interruptId: 'af-x', status: 'cancelled' }] });
    expect((http.requests[0].body as { resume: { payload?: unknown }[] }).resume[0].payload).toBeUndefined();
  });
});

describe('agent client: headers and abort', () => {
  it('injects a fresh bearer token per run', async () => {
    const { client, http } = setup(() => sseResponse(approvalCancel), ['token-1', 'token-2']);
    await client.run(builder().resume([{ interruptId: 'a', cancelled: true }]));
    await client.run(builder().resume([{ interruptId: 'a', cancelled: true }]));
    expect(http.requests.map((request) => request.headers.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('omits the Authorization header in platform mode (null token)', async () => {
    const { client, http } = setup([sseResponse(approvalCancel)], null);
    await client.run(builder().resume([{ interruptId: 'a', cancelled: true }]));
    expect(http.requests[0].headers.has('authorization')).toBe(false);
  });

  it('aborts through abort() and through the signal', async () => {
    const pending = (request: { url: string }, _i: number) => new Promise<Response>(() => undefined);
    const slow = vi.fn(pending);
    const http = fakeFetch(slow as never);
    const abortable = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        void http.fetch(input, init);
      })) as typeof fetch;
    const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'backlog-refiner', tokenProvider: fakeTokens(), fetch: abortable });

    const first = client.run(builder().userMessage('a'));
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    client.abort();
    expect(await first).toMatchObject({ status: 'aborted' });

    const controller = new AbortController();
    const second = client.run(builder().userMessage('b'), {}, controller.signal);
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await second).toMatchObject({ status: 'aborted' });
  });
});

describe('agent client: errors', () => {
  it('maps RUN_ERROR APPROVAL_RESUME_NOT_FOUND to proposalExpired', async () => {
    const { client } = setup([sseResponse(errNotFound)]);
    const events: RunEvent[] = [];
    const outcome = await client.run(builder().resume([{ interruptId: 'a', approved: true }]), { onEvent: (event) => events.push(event) });
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error).toMatchObject({ code: 'APPROVAL_RESUME_NOT_FOUND', key: 'approvalExpired', proposalExpired: true, retryable: false, runId: 'run-err1' });
    expect(events.at(-1)).toMatchObject({ type: 'runError', code: 'APPROVAL_RESUME_NOT_FOUND', runId: 'run-err1' });
  });

  it('maps RUN_ERROR APPROVAL_RESUME_REQUIRED and normalises raw exception names to INTERNAL', async () => {
    const required = await setup([sseResponse(errRequired)]).client.run(builder().userMessage('x'));
    expect(required).toMatchObject({ status: 'error', error: { code: 'APPROVAL_RESUME_REQUIRED', approvalRequired: true } });
    const raw = await setup([sseResponse(errRaw)]).client.run(builder().userMessage('x'));
    expect(raw).toMatchObject({ status: 'error', error: { code: 'INTERNAL', retryable: true } });
  });

  it('maps HTTP 401 (reports to the token provider), 409, 429 with Retry-After and 413', async () => {
    const cases: [number, Record<string, string>, object][] = [
      [401, {}, { code: 'UNAUTHENTICATED', key: 'unauthenticated' }],
      [409, {}, { code: 'THREAD_BUSY', key: 'threadBusy', retryable: true }],
      [429, { 'Retry-After': '12' }, { code: 'RATE_LIMITED', retryAfterSeconds: 12, retryable: true }],
      [413, {}, { key: 'payloadTooLarge', retryable: false }],
      [503, {}, { key: 'serviceUnavailable', retryable: true }],
    ];
    for (const [status, headers, expected] of cases) {
      const { client, provider } = setup([problemResponse(status, { detail: 'nope' }, headers)]);
      const events: RunEvent[] = [];
      const outcome = await client.run(builder().userMessage('x'), { onEvent: (event) => events.push(event) });
      expect(outcome).toMatchObject({ status: 'error', error: { status, source: 'http', ...expected } });
      expect(events.at(-1)).toMatchObject({ type: 'runError' });
      expect(provider.unauthorized).toBe(status === 401 ? 1 : 0);
    }
  });

  it('maps network failures and streams that end without RUN_FINISHED', async () => {
    const down = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
    expect(await down.run(builder().userMessage('x'))).toMatchObject({ status: 'error', error: { source: 'network', key: 'network', retryable: true } });

    const truncated = setup([sseResponse(askRun.slice(0, 5))]);
    expect(await truncated.client.run(builder().userMessage('x'))).toMatchObject({ status: 'error', error: { key: 'streamInterrupted' } });
  });
});
