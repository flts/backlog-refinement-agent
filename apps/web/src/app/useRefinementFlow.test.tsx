import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../domain/backlog-item';
import type { Backlog } from './useBacklog';
import { agentNotConnectedNotice, useRefinementFlow } from './useRefinementFlow';

afterEach(() => localStorage.clear());

function setup(item: Partial<BacklogItem> = { id: 'item', status: 'draft' }) {
  const updateSelected = vi.fn().mockResolvedValue(true);
  const setError = vi.fn();
  const setNotice = vi.fn();
  const backlog = { selectedItem: item, session: { id: 'session' }, updateSelected } as unknown as Backlog;
  const { result } = renderHook(() => useRefinementFlow(backlog, { error: '', notice: '', clear: vi.fn(), setError, setNotice }));
  return { result, updateSelected, setError, setNotice };
}

describe('manual status changes', () => {
  it('moves a draft through refining before marking it ready', async () => {
    const { result, updateSelected, setError } = setup();
    await act(() => result.current.changeSelectedStatus('ready'));
    expect(updateSelected.mock.calls).toEqual([[{ status: 'refining' }], [{ status: 'ready' }]]);
    expect(setError).not.toHaveBeenCalled();
  });

  it.each(['ready', 'ready-with-open-questions', 'complete'] as const)('allows %s to return to refining', async (status) => {
    const { result, updateSelected } = setup({ id: 'item', status });
    await act(() => result.current.changeSelectedStatus('refining'));
    expect(updateSelected).toHaveBeenCalledWith({ status: 'refining' });
  });
});

describe('agent not connected yet', () => {
  it('shows a non-blocking notice instead of calling an LLM', async () => {
    const { result, setNotice, setError } = setup();
    await act(() => result.current.submitMessage());
    expect(setNotice).toHaveBeenCalledWith(agentNotConnectedNotice);
    expect(setError).toHaveBeenCalledWith('');
    expect(result.current.busy).toBe(false);
  });
});
