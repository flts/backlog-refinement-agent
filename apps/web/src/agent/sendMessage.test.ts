import { describe, expect, it } from 'vitest';
import { createAgentClient } from './agentClient';
import { RunInputBuilder } from './runInput';
import { sendMessageCancellingPending } from './sendMessage';
import { fakeFetch, fakeTokens, problemResponse, sseResponse } from './testing';
import cancelRun from './__fixtures__/approval.cancel.json';
import answerRun from './__fixtures__/ask-user.answer.json';
import notFound from './__fixtures__/error.resume-not-found.json';

const builder = () => new RunInputBuilder({ threadId: 'thr-1', projectId: 'p1', itemId: 'i1' });

describe('sendMessageCancellingPending (spike #8)', () => {
  it('cancels the pending interrupt first, then sends the message in a second run', async () => {
    const http = fakeFetch([sseResponse(cancelRun), sseResponse(answerRun)]);
    const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
    const result = await sendMessageCancellingPending(client, builder(), { text: 'new direction', interrupts: [{ id: 'af-1' }] });
    expect(result.status).toBe('sent');
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0].body).toMatchObject({ messages: [], resume: [{ interruptId: 'af-1', status: 'cancelled' }] });
    expect(http.requests[1].body).toMatchObject({ messages: [{ role: 'user', content: 'new direction' }] });
    expect((http.requests[1].body as { resume?: unknown }).resume).toBeUndefined();
  });

  it('does not send the message when the cancel run failed', async () => {
    const http = fakeFetch([sseResponse(notFound)]);
    const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
    const result = await sendMessageCancellingPending(client, builder(), { text: 'x', interrupts: [{ id: 'af-1' }] });
    expect(result).toMatchObject({ status: 'cancelFailed', cancelOutcome: { status: 'error', error: { proposalExpired: true } } });
    expect(http.requests).toHaveLength(1);
  });

  it('is a plain run without pending interrupts', async () => {
    const http = fakeFetch([sseResponse(answerRun), problemResponse(500, {})]);
    const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
    expect((await sendMessageCancellingPending(client, builder(), { text: 'hi' })).status).toBe('sent');
    expect(http.requests).toHaveLength(1);
  });
});
