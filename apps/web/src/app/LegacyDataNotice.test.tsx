import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { legacyDataExists, legacyNoticeDismissedKey, removeLegacyData, type LegacyDataDeps } from '../infrastructure/legacy-data';
import { expectNoAxeViolations } from '../test/axe';
import { LEGACY_NOTICE_ENABLED, LegacyDataNotice } from './LegacyDataNotice';

/** Minimal IndexedDB stand-in: the app itself no longer uses IndexedDB, only the removal of the old database does. */
function fakeDeps(names: string[]) {
  const databases = [...names];
  const store = new Map<string, string>([['llm-connection-overrides', '{}'], ['review-ai-changes', '1'], ['theme-preference', 'dark']]);
  const idb = {
    databases: async () => databases.map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => { databases.splice(databases.indexOf(name), 1); request.onsuccess?.(new Event('success')); });
      return request;
    },
  } as unknown as LegacyDataDeps['idb'];
  const storage: LegacyDataDeps['storage'] = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
  };
  return { deps: { idb, storage } satisfies LegacyDataDeps, store, databases };
}

describe('legacy data', () => {
  it('is enabled now that IndexedDB is gone', () => {
    expect(LEGACY_NOTICE_ENABLED).toBe(true);
  });

  it('detects the old database and ignores unsupported browsers', async () => {
    expect(await legacyDataExists(fakeDeps([]).deps)).toBe(false);
    expect(await legacyDataExists(fakeDeps(['backlog-refinement-agent']).deps)).toBe(true);
    expect(await legacyDataExists(fakeDeps(['something-else']).deps)).toBe(false);
    expect(await legacyDataExists({ idb: { deleteDatabase: vi.fn() } as unknown as IDBFactory })).toBe(false);
  });

  it('deletes the database and legacy keys but keeps the theme', async () => {
    const { deps, store, databases } = fakeDeps(['backlog-refinement-agent']);
    await removeLegacyData(deps);
    expect(databases).toEqual([]);
    expect(store.has('llm-connection-overrides')).toBe(false);
    expect(store.has('review-ai-changes')).toBe(false);
    expect(store.get('theme-preference')).toBe('dark');
  });
});

describe('LegacyDataNotice', () => {
  it('renders nothing while disabled', async () => {
    const { container } = render(<LegacyDataNotice enabled={false} deps={fakeDeps(['backlog-refinement-agent']).deps} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without legacy data or after dismissal', async () => {
    const { container, unmount } = render(<LegacyDataNotice enabled deps={fakeDeps([]).deps} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    unmount();
    const dismissed = fakeDeps(['backlog-refinement-agent']);
    dismissed.store.set(legacyNoticeDismissedKey, '1');
    const second = render(<LegacyDataNotice enabled deps={dismissed.deps} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('removes old data only after confirmation', async () => {
    const user = userEvent.setup();
    const { deps, store, databases } = fakeDeps(['backlog-refinement-agent']);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container } = render(<LegacyDataNotice enabled deps={deps} confirm={confirm} />);
    await screen.findByRole('heading', { name: 'Old local data found' });
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Remove old local data' }));
    expect(databases).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove old local data' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Old local data found' })).toBeNull());
    expect(databases).toHaveLength(0);
    expect(store.get(legacyNoticeDismissedKey)).toBe('1');
  });

  it('can be dismissed and remembers it', async () => {
    const user = userEvent.setup();
    const { deps, store, databases } = fakeDeps(['backlog-refinement-agent']);
    render(<LegacyDataNotice enabled deps={deps} />);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('heading', { name: 'Old local data found' })).toBeNull();
    expect(store.get(legacyNoticeDismissedKey)).toBe('1');
    expect(databases).toHaveLength(1);
  });
});
