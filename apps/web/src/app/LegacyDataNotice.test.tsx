import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseName } from '../infrastructure/storage/database';
import { legacyDataExists, legacyNoticeDismissedKey, removeLegacyData } from '../infrastructure/legacy-data';
import { expectNoAxeViolations } from '../test/axe';
import { LEGACY_NOTICE_ENABLED, LegacyDataNotice } from './LegacyDataNotice';

afterEach(async () => { localStorage.clear(); await Dexie.delete(databaseName); });

async function createLegacyDatabase() {
  const db = new Dexie(databaseName);
  db.version(1).stores({ projects: 'id' });
  await db.open();
  db.close();
}

describe('legacy data', () => {
  it('stays disabled until the API client replaces IndexedDB', () => {
    expect(LEGACY_NOTICE_ENABLED).toBe(false);
  });

  it('detects the old database and ignores unsupported browsers', async () => {
    expect(await legacyDataExists()).toBe(false);
    await createLegacyDatabase();
    expect(await legacyDataExists()).toBe(true);
    expect(await legacyDataExists({ idb: { deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB) } as unknown as IDBFactory })).toBe(false);
  });

  it('deletes the database and legacy keys', async () => {
    await createLegacyDatabase();
    localStorage.setItem('llm-connection-overrides', '{}');
    localStorage.setItem('review-ai-changes', '1');
    localStorage.setItem('theme-preference', 'dark');
    await removeLegacyData();
    expect(await legacyDataExists()).toBe(false);
    expect(localStorage.getItem('llm-connection-overrides')).toBeNull();
    expect(localStorage.getItem('review-ai-changes')).toBeNull();
    expect(localStorage.getItem('theme-preference')).toBe('dark');
  });
});

describe('LegacyDataNotice', () => {
  it('renders nothing while disabled', async () => {
    await createLegacyDatabase();
    const { container } = render(<LegacyDataNotice />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without legacy data or after dismissal', async () => {
    const { container, unmount } = render(<LegacyDataNotice enabled />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    unmount();
    await createLegacyDatabase();
    localStorage.setItem(legacyNoticeDismissedKey, '1');
    const second = render(<LegacyDataNotice enabled />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('removes old data only after confirmation', async () => {
    const user = userEvent.setup();
    await createLegacyDatabase();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container } = render(<LegacyDataNotice enabled confirm={confirm} />);
    await screen.findByRole('heading', { name: 'Old local data found' });
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Remove old local data' }));
    expect(await legacyDataExists()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Remove old local data' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Old local data found' })).toBeNull());
    expect(await legacyDataExists()).toBe(false);
    expect(localStorage.getItem(legacyNoticeDismissedKey)).toBe('1');
  });

  it('can be dismissed and remembers it', async () => {
    const user = userEvent.setup();
    await createLegacyDatabase();
    render(<LegacyDataNotice enabled />);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('heading', { name: 'Old local data found' })).toBeNull();
    expect(localStorage.getItem(legacyNoticeDismissedKey)).toBe('1');
    expect(await legacyDataExists()).toBe(true);
  });
});
