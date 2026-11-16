import type { ItemStatus } from '../api';
import type { Backlog } from './useBacklog';

/** A draft goes through `refining` before it can be marked ready. */
export async function changeSelectedStatus(backlog: Pick<Backlog, 'selectedItem' | 'changeStatus'>, status: ItemStatus): Promise<void> {
  const { selectedItem, changeStatus } = backlog;
  if (!selectedItem) return;
  if (selectedItem.status === 'draft' && status === 'ready' && !(await changeStatus('refining'))) return;
  await changeStatus(status);
}
