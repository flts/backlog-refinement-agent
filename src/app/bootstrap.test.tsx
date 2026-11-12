import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bootstrap } from './Bootstrap';
import { backlogDatabase, databaseName } from '../infrastructure/storage/database';

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  backlogDatabase.close();
  await Dexie.delete(databaseName);
});

describe('startup reset', () => {
  it('keeps old backlog until explicit confirmation', async () => {
    const old = new Dexie(databaseName);
    old.version(1).stores({
      backlogItems: 'id, type, status, updatedAt', relationships: '++id, [sourceId+targetId+type], sourceId, targetId, type',
      sessions: 'id, backlogItemId, status, updatedAt', settings: 'id',
    });
    await old.table('backlogItems').add({ id: 'old-item' });
    old.close();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(<Bootstrap />);
    const reset = await screen.findByRole('button', { name: /Discard old backlog/ });
    await user.click(reset);
    const check = new Dexie(databaseName);
    check.version(1).stores({
      backlogItems: 'id, type, status, updatedAt', relationships: '++id, [sourceId+targetId+type], sourceId, targetId, type',
      sessions: 'id, backlogItemId, status, updatedAt', settings: 'id',
    });
    expect(await check.table('backlogItems').count()).toBe(1);
    check.close();
    await user.click(reset);
    await screen.findByText('Create or import a project to start a backlog.');
    await waitFor(async () => expect(await backlogDatabase.backlogItems.count()).toBe(0));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
