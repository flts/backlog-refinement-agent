import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../agent';
import { fakeFetch, fakeTokens, sseResponse } from '../agent/testing';
import { backlogKeys } from '../api';
import { AgentRunService } from './AgentRunService';
import askRun from '../agent/__fixtures__/ask-user.run.json';
import askAnswer from '../agent/__fixtures__/ask-user.answer.json';
import approvalPropose from '../agent/__fixtures__/approval.propose.json';
import approvalHydrate from '../agent/__fixtures__/approval.hydrate.json';
import approvalResume from '../agent/__fixtures__/approval.resume.json';
import approvalCancel from '../agent/__fixtures__/approval.cancel.json';
import errNotFound from '../agent/__fixtures__/error.resume-not-found.json';
import errRaw from '../agent/__fixtures__/error.internal-raw-code.json';
import askHydrate from '../agent/__fixtures__/ask-user.hydrate.json';

const INTERRUPT_ID = 'af-call-6dd7f028c7434143b100efc14e149ad9';

function setup(responses: Parameters<typeof fakeFetch>[0]) {
  const http = fakeFetch(responses);
  const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  let n = 0;
  const service = new AgentRunService({ client, threadId: 'thr-1', projectId: 'p1', itemId: 'item-42', itemType: 'feature', queryClient, newId: () => `id-${++n}` });
  const body = (index: number) => http.requests[index].body as { runId: string; messages: { id: string; role: string; content: string; toolCallId?: string }[]; resume?: unknown[] };
  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
  return { service, http, body, invalidatedKeys, invalidate };
}

describe('AgentRunService', () => {
  it('hydrates an idle thread without a model call', async () => {
    const { service, http } = setup([sseResponse([
      { type: 'RUN_STARTED', threadId: 'thr-1', runId: 'h' },
      { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'hello' }] },
      { type: 'RUN_FINISHED', threadId: 'thr-1', runId: 'h' },
    ])]);
    expect(service.getState().phase).toBe('hydrating');
    await service.hydrate();
    expect(service.getState().phase).toBe('idle');
    expect(service.getState().messages.map((entry) => entry.kind)).toEqual(['user', 'assistant']);
    expect((http.requests[0].body as { messages: unknown[] }).messages).toEqual([]);
  });

  it('hydrates a pending ask_user and a pending approval', async () => {
    const ask = setup([sseResponse(askHydrate)]);
    await ask.service.hydrate();
    expect(ask.service.getState()).toMatchObject({ phase: 'awaitingInput', pendingAskUser: { toolCallId: 'call_ask_1' } });
    const review = setup([sseResponse(approvalHydrate)]);
    await review.service.hydrate();
    expect(review.service.getState()).toMatchObject({ phase: 'awaitingReview' });
    expect(review.service.getState().interrupts[0].id).toBe(INTERRUPT_ID);
  });

  it('send → success: streams text into the state and notifies subscribers', async () => {
    const { service, body } = setup([sseResponse(askRun)]);
    const listener = vi.fn();
    service.subscribe(listener);
    const result = await service.send('Refine this feature');
    expect(result.status).toBe('success');
    expect(listener).toHaveBeenCalled();
    expect(service.getState().phase).toBe('awaitingInput');
    expect(body(0).messages).toEqual([{ id: 'id-1', role: 'user', content: 'Refine this feature' }]);
  });

  it('ask_user pending → answer sends a tool-message-only run', async () => {
    const { service, body } = setup([sseResponse(askRun), sseResponse(askAnswer)]);
    await service.send('Refine');
    await service.answer({ status: 'answered', answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }] });
    expect(body(1).messages).toHaveLength(1);
    expect(body(1).messages[0]).toMatchObject({ role: 'tool', toolCallId: 'call_ask_1' });
    expect(service.getState().phase).toBe('idle');
  });

  it('typing while a question is pending sends only a prefixed user message (dismissal, spike #9)', async () => {
    const { service, body } = setup([sseResponse(askRun), sseResponse(askAnswer)]);
    await service.send('Refine');
    await service.send('Assume admins');
    expect(body(1).messages).toHaveLength(1);
    expect(body(1).messages[0]).toMatchObject({ role: 'user', content: '[dismissed question q1] Assume admins' });
    expect(service.getState().messages.filter((entry) => entry.kind === 'user').map((entry) => entry.kind === 'user' && entry.text)).toEqual(['Refine', 'Assume admins']);
  });

  it('answers an ask_user with invalid arguments with an error tool message (once)', async () => {
    const invalid = [
      { type: 'RUN_STARTED', threadId: 'thr-1', runId: 'r1' },
      { type: 'TOOL_CALL_START', toolCallId: 'bad', toolCallName: 'ask_user' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'bad', delta: '{"questions":[]}' },
      { type: 'TOOL_CALL_END', toolCallId: 'bad' },
      { type: 'RUN_FINISHED', threadId: 'thr-1', runId: 'r1' },
    ];
    const { service, body } = setup([sseResponse(invalid), sseResponse(askAnswer)]);
    await service.send('x');
    expect(body(1).messages[0]).toMatchObject({ role: 'tool', toolCallId: 'bad' });
    expect(body(1).messages[0]).toHaveProperty('error');
    expect(service.getState().phase).toBe('idle');
  });

  it('interrupt → decide with edited args sends a full-replacement resume and invalidates the item queries', async () => {
    const { service, body, invalidatedKeys } = setup([sseResponse(approvalPropose), sseResponse(approvalResume)]);
    await service.send('improve');
    expect(service.getState().phase).toBe('awaitingReview');
    const [interrupt] = service.getState().interrupts;
    const edited = { ...interrupt.args, sections: [{ id: 's1', heading: 'Summary', mode: 'replace', markdown: 'Edited' }] };
    const result = await service.decide([{ interruptId: interrupt.id, approved: true, editedArgs: edited }]);
    expect(result.status).toBe('success');
    expect(body(1).messages).toEqual([]);
    expect(body(1).resume).toEqual([{ interruptId: INTERRUPT_ID, status: 'resolved', payload: { approved: true, editedArgs: edited } }]);
    expect(service.getState().phase).toBe('idle');
    const keys = invalidatedKeys();
    for (const key of [backlogKeys.item('p1', 'item-42'), backlogKeys.items('p1'), backlogKeys.revisions('p1', 'item-42'), backlogKeys.relationships('p1')]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });

  it('does not invalidate the backlog for runs that wrote nothing', async () => {
    const { service, invalidatedKeys } = setup([sseResponse(askRun)]);
    await service.send('x');
    expect(invalidatedKeys()).not.toContain(JSON.stringify(backlogKeys.items('p1')));
  });

  it('decideAll builds the resume from the pending interrupts', async () => {
    const { service, body } = setup([sseResponse(approvalPropose), sseResponse(approvalCancel)]);
    await service.send('improve');
    await service.decideAll(false);
    expect(body(1).resume).toEqual([{ interruptId: INTERRUPT_ID, status: 'resolved', payload: { approved: false } }]);
  });

  it('rejects decisions that do not cover every pending interrupt', async () => {
    const { service, http } = setup([sseResponse(approvalPropose)]);
    await service.send('improve');
    expect(await service.decide([{ interruptId: 'other', approved: true }])).toMatchObject({ status: 'invalid' });
    expect(http.requests).toHaveLength(1);
  });

  it('send during awaitingReview cancels the interrupt first, then sends the message (spike #8)', async () => {
    const { service, body } = setup([sseResponse(approvalPropose), sseResponse(approvalCancel), sseResponse(askAnswer)]);
    await service.send('improve');
    const result = await service.send('Actually, focus on the ACs');
    expect(result.status).toBe('success');
    expect(body(1).resume).toEqual([{ interruptId: INTERRUPT_ID, status: 'cancelled' }]);
    expect(body(1).messages).toEqual([]);
    expect(body(2).messages[0]).toMatchObject({ role: 'user', content: 'Actually, focus on the ACs' });
    expect(body(2).resume).toBeUndefined();
    expect(service.getState().phase).toBe('idle');
    expect(service.getState().interrupts).toEqual([]);
  });

  it('does not send the message when cancelling the interrupt failed', async () => {
    const { service, http } = setup([sseResponse(approvalPropose), sseResponse(errRaw)]);
    await service.send('improve');
    expect(await service.send('later')).toMatchObject({ status: 'cancelFailed' });
    expect(http.requests).toHaveLength(2);
    expect(service.getState().phase).toBe('error');
  });

  it('APPROVAL_RESUME_NOT_FOUND marks the proposal expired and retry asks to refine again', async () => {
    const { service, body } = setup([sseResponse(approvalPropose), sseResponse(errNotFound), sseResponse(askAnswer)]);
    await service.send('improve');
    await service.decideAll(true);
    const state = service.getState();
    expect(state.phase).toBe('error');
    expect(state.interrupts[0]).toMatchObject({ expired: true });
    await service.retry();
    expect(body(2).resume).toBeUndefined();
    expect(body(2).messages[0]).toMatchObject({ role: 'user', content: 'Refine this item.' });
    expect(service.getState().interrupts).toEqual([]);
  });

  it('retry re-sends the last request with a NEW runId and does not duplicate the user message', async () => {
    const { service, body } = setup([sseResponse(errRaw), sseResponse(askAnswer)]);
    await service.send('hello');
    expect(service.getState().phase).toBe('error');
    await service.retry();
    expect(body(1).runId).not.toBe(body(0).runId);
    expect(body(1).messages).toEqual(body(0).messages);
    expect(service.getState().phase).toBe('idle');
    expect(service.getState().messages.filter((entry) => entry.kind === 'user')).toHaveLength(1);
    expect(service.getState().messages.some((entry) => entry.kind === 'error')).toBe(false);
  });

  it('a second operation while one is running is refused locally (no duplicate request)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, http } = setup(async () => { await gate; return sseResponse(askAnswer); });
    const first = service.send('one');
    await vi.waitFor(() => expect(http.requests).toHaveLength(1));
    expect(await service.send('two')).toEqual({ status: 'busy' });
    release();
    await first;
    expect(http.requests).toHaveLength(1);
  });

  it('stop aborts the run and ends in cancelled', async () => {
    const http = fakeFetch(() => new Promise<Response>(() => undefined));
    const abortable = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      void http.fetch(input, init);
    })) as typeof fetch;
    const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: abortable });
    const service = new AgentRunService({ client, threadId: 'thr-1', projectId: 'p1', itemId: 'i' });
    const sending = service.send('slow');
    await vi.waitFor(() => expect(service.getState().phase).toBe('running'));
    await vi.waitFor(() => expect(http.requests).toHaveLength(1));
    service.stop();
    expect(service.getState().phase).toBe('cancelled');
    expect((await sending)).toMatchObject({ status: 'aborted' });
    expect(service.getState().phase).toBe('cancelled');
    // The queue slot is free again.
    expect(await service.send(' ')).toMatchObject({ status: 'invalid' });
  });

  it('refreshes the thread list after every operation', async () => {
    const { service, invalidatedKeys } = setup([sseResponse(askAnswer)]);
    await service.send('x');
    expect(invalidatedKeys()).toContain(JSON.stringify(['agent', 'threads', 'p1', 'item-42']));
  });
});
