import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Item } from '../api';
import { agentNotConnectedNotice, useRefinementFlow } from './useRefinementFlow';

function setup(item: Partial<Item> = { id: 'item', status: 'draft' }) {
  const changeStatus = vi.fn().mockResolvedValue(true);
  const undoLastChange = vi.fn().mockResolvedValue(true);
  const setError = vi.fn();
  const setNotice = vi.fn();
  const { result } = renderHook(() => useRefinementFlow({ selectedItem: item as Item, changeStatus, undoLastChange }, { setError, setNotice }));
  return { result, changeStatus, undoLastChange, setError, setNotice };
}

describe('manual status changes', () => {
  it('moves a draft through refining before marking it ready', async () => {
    const { result, changeStatus } = setup();
    await act(() => result.current.changeSelectedStatus('ready'));
    expect(changeStatus.mock.calls).toEqual([['refining'], ['ready']]);
  });

  it('does not continue when the first transition fails', async () => {
    const { result, changeStatus } = setup();
    changeStatus.mockResolvedValueOnce(false);
    await act(() => result.current.changeSelectedStatus('ready'));
    expect(changeStatus.mock.calls).toEqual([['refining']]);
  });

  it.each(['ready', 'ready-with-open-questions', 'complete'] as const)('allows %s to return to refining', async (status) => {
    const { result, changeStatus } = setup({ id: 'item', status });
    await act(() => result.current.changeSelectedStatus('refining'));
    expect(changeStatus).toHaveBeenCalledWith('refining');
  });
});

describe('server revisions', () => {
  it('undo restores through the backlog', () => {
    const { result, undoLastChange } = setup();
    act(() => result.current.undoLastChange());
    expect(undoLastChange).toHaveBeenCalledOnce();
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
