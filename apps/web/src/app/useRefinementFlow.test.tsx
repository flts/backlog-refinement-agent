import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../domain/backlog-item';
import type { RefinementApplicationService } from '../application/refinement-service';
import type { Backlog } from './useBacklog';
import { useRefinementFlow } from './useRefinementFlow';

describe('manual refinement status changes', () => {
  it('moves a draft through refining before marking it ready', async () => {
    const item = { id: 'item', status: 'draft' } as BacklogItem;
    const beginRefinement = vi.fn().mockResolvedValue({ ...item, status: 'refining' });
    const updateSelected = vi.fn().mockResolvedValue(true);
    const setItems = vi.fn();
    const setError = vi.fn();
    const backlog = { selectedItem: item, session: { id: 'session' }, setItems, updateSelected } as unknown as Backlog;
    const refinement = { beginRefinement } as unknown as RefinementApplicationService;
    const { result } = renderHook(() => useRefinementFlow(backlog, refinement, { error: '', notice: '', clear: vi.fn(), setError, setNotice: vi.fn() }));

    await act(() => result.current.changeSelectedStatus('ready'));

    expect(beginRefinement).toHaveBeenCalledWith('session');
    expect(beginRefinement.mock.invocationCallOrder[0]).toBeLessThan(updateSelected.mock.invocationCallOrder[0]);
    expect(updateSelected).toHaveBeenCalledWith({ status: 'ready' });
    expect(setItems).toHaveBeenCalledOnce();
    expect(setError).not.toHaveBeenCalled();
  });

  it.each(['ready', 'ready-with-open-questions', 'complete'] as const)(
    'allows %s to return to refining even while the session is loading',
    async (status) => {
      const updateSelected = vi.fn().mockResolvedValue(true);
      const backlog = { selectedItem: { id: 'item', status }, updateSelected } as unknown as Backlog;
      const { result } = renderHook(() => useRefinementFlow(backlog, {} as RefinementApplicationService, { error: '', notice: '', clear: vi.fn(), setError: vi.fn(), setNotice: vi.fn() }));

      await act(() => result.current.changeSelectedStatus('refining'));

      expect(updateSelected).toHaveBeenCalledWith({ status: 'refining' });
    },
  );
});
