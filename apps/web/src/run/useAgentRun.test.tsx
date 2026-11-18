import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../agent';
import { fakeFetch, fakeTokens, sseResponse } from '../agent/testing';
import { createFakeAgentBackend } from '../test/fakeAgentBackend';
import { testQueryClient } from '../test/render';
import { TestAgentClientProvider } from './AgentClientProvider';
import { useAgentRun } from './useAgentRun';
import askHydrate from '../agent/__fixtures__/ask-user.hydrate.json';
import askAnswer from '../agent/__fixtures__/ask-user.answer.json';

function setup(responses: Parameters<typeof fakeFetch>[0], threadId: string | null = 'thr-1', ensureThread?: () => Promise<{ id: string }>) {
  const http = fakeFetch(responses);
  const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
  const { backend } = createFakeAgentBackend({ client });
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><TestAgentClientProvider backend={backend}>{children}</TestAgentClientProvider></QueryClientProvider>;
  const hook = renderHook(({ id }) => useAgentRun(id ?? undefined, { projectId: 'p1', itemId: 'item-42', itemType: 'feature', ensureThread }), { wrapper, initialProps: { id: threadId } });
  return { hook, http };
}

describe('useAgentRun', () => {
  it('hydrates on open and restores a pending question', async () => {
    const { hook } = setup([sseResponse(askHydrate)]);
    expect(hook.result.current.state.phase).toBe('hydrating');
    await waitFor(() => expect(hook.result.current.state.phase).toBe('awaitingInput'));
    expect(hook.result.current.state.pendingAskUser?.toolCallId).toBe('call_ask_1');
  });

  it('answers the question and returns to idle', async () => {
    const { hook, http } = setup([sseResponse(askHydrate), sseResponse(askAnswer)]);
    await waitFor(() => expect(hook.result.current.state.phase).toBe('awaitingInput'));
    await act(async () => { await hook.result.current.answer({ status: 'skipped', answers: [{ questionId: 'q1', selected: [], skipped: true }] }); });
    expect(hook.result.current.state.phase).toBe('idle');
    expect(http.requests).toHaveLength(2);
  });

  it('creates the thread lazily for the first message', async () => {
    const ensure = vi.fn(async () => ({ id: 'thr-new' }));
    const { hook, http } = setup([sseResponse(askAnswer)], null, ensure);
    expect(hook.result.current.state.phase).toBe('idle');
    await act(async () => { await hook.result.current.send('hello'); });
    expect(ensure).toHaveBeenCalledOnce();
    expect((http.requests[0].body as { threadId: string }).threadId).toBe('thr-new');
  });

  it('resets the state when the thread changes and aborts the active run', async () => {
    const { hook } = setup([sseResponse(askHydrate), sseResponse(askAnswer)]);
    await waitFor(() => expect(hook.result.current.state.phase).toBe('awaitingInput'));
    hook.rerender({ id: 'thr-2' });
    expect(hook.result.current.state.threadId).toBe('thr-2');
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  });
});
