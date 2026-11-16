import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createFakeAgentBackend, makeThread } from '../test/fakeAgentBackend';
import { testQueryClient } from '../test/render';
import { TestAgentClientProvider, type AgentBackend } from './AgentClientProvider';
import { agentKeys } from './keys';
import { useThreads } from './useThreads';

function setup(threads = [makeThread({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }), makeThread({ id: 'new', updatedAt: '2026-01-05T00:00:00Z' })]) {
  const fake = createFakeAgentBackend({ threads });
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><TestAgentClientProvider backend={fake.backend as AgentBackend}>{children}</TestAgentClientProvider></QueryClientProvider>;
  const hook = renderHook(() => useThreads('p1', 'i1'), { wrapper });
  return { ...fake, hook, queryClient };
}

describe('useThreads', () => {
  it('lists the threads of the item newest first and activates the newest', async () => {
    const { hook, queryClient } = setup();
    await waitFor(() => expect(hook.result.current.threads).toHaveLength(2));
    expect(hook.result.current.threads.map((thread) => thread.id)).toEqual(['new', 'old']);
    expect(hook.result.current.activeThreadId).toBe('new');
    expect(queryClient.getQueryData(agentKeys.threads('p1', 'i1'))).toHaveLength(2);
    expect(agentKeys.threads('p1', 'i1')).toEqual(['agent', 'threads', 'p1', 'i1']);
  });

  it('selects, renames and removes threads', async () => {
    const { hook, calls } = setup();
    await waitFor(() => expect(hook.result.current.threads).toHaveLength(2));
    act(() => hook.result.current.selectThread('old'));
    expect(hook.result.current.activeThreadId).toBe('old');
    await act(() => hook.result.current.rename('old', 'Scope'));
    await waitFor(() => expect(hook.result.current.threads.find((thread) => thread.id === 'old')?.title).toBe('Scope'));
    await act(() => hook.result.current.remove('old'));
    await waitFor(() => expect(hook.result.current.threads.map((thread) => thread.id)).toEqual(['new']));
    expect(hook.result.current.activeThreadId).toBe('new');
    expect(calls).toContain('rename');
    expect(calls).toContain('remove');
  });

  it('creates a thread and makes it active', async () => {
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.threads).toHaveLength(2));
    await act(async () => { await hook.result.current.create('Fresh'); });
    await waitFor(() => expect(hook.result.current.threads).toHaveLength(3));
    expect(hook.result.current.activeThreadId).toBe('new-1');
  });

  it('ensureThread creates the first thread only when there is none, and reuses it afterwards', async () => {
    const { hook, calls } = setup([]);
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    let first!: { id: string };
    await act(async () => { first = await hook.result.current.ensureThread(); });
    expect(first.id).toBe('new-1');
    await waitFor(() => expect(hook.result.current.activeThreadId).toBe('new-1'));
    let second!: { id: string };
    await act(async () => { second = await hook.result.current.ensureThread(); });
    expect(second.id).toBe('new-1');
    expect(calls.filter((call) => call === 'create')).toHaveLength(1);
  });
});
