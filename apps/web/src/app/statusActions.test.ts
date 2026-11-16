import { describe, expect, it, vi } from 'vitest';
import type { Item } from '../api';
import { changeSelectedStatus } from './statusActions';

function setup(item: Partial<Item> = { id: 'item', status: 'draft' }) {
  const changeStatus = vi.fn().mockResolvedValue(true);
  return { changeStatus, run: (status: Parameters<typeof changeSelectedStatus>[1]) => changeSelectedStatus({ selectedItem: item as Item, changeStatus }, status) };
}

describe('manual status changes', () => {
  it('moves a draft through refining before marking it ready', async () => {
    const { run, changeStatus } = setup();
    await run('ready');
    expect(changeStatus.mock.calls).toEqual([['refining'], ['ready']]);
  });

  it('does not continue when the first transition fails', async () => {
    const { run, changeStatus } = setup();
    changeStatus.mockResolvedValueOnce(false);
    await run('ready');
    expect(changeStatus.mock.calls).toEqual([['refining']]);
  });

  it.each(['ready', 'ready-with-open-questions', 'complete'] as const)('allows %s to return to refining', async (status) => {
    const { run, changeStatus } = setup({ id: 'item', status });
    await run('refining');
    expect(changeStatus).toHaveBeenCalledWith('refining');
  });
});
