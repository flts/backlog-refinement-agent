import { databaseName } from './storage/database';

/** Browser data of the former local-only app (IndexedDB database and localStorage keys). */
export const legacyDatabaseNames = [databaseName] as const;
export const legacyStorageKeys = ['llm-connection-overrides', 'review-ai-changes'] as const;
export const legacyNoticeDismissedKey = 'legacy-data-notice-dismissed';

export interface LegacyDataDeps {
  idb?: Pick<IDBFactory, 'databases' | 'deleteDatabase'>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

/** True when an old local database exists. Browsers without `indexedDB.databases()` report false. */
export async function legacyDataExists({ idb = indexedDB }: LegacyDataDeps = {}): Promise<boolean> {
  if (typeof idb?.databases !== 'function') return false;
  try {
    const databases = await idb.databases();
    return databases.some((entry) => entry.name !== undefined && (legacyDatabaseNames as readonly string[]).includes(entry.name));
  } catch {
    return false;
  }
}

export function isLegacyNoticeDismissed({ storage = localStorage }: LegacyDataDeps = {}): boolean {
  try { return storage.getItem(legacyNoticeDismissedKey) === '1'; } catch { return false; }
}

export function dismissLegacyNotice({ storage = localStorage }: LegacyDataDeps = {}): void {
  try { storage.setItem(legacyNoticeDismissedKey, '1'); } catch { /* the notice may then reappear; harmless */ }
}

function deleteDatabase(idb: Pick<IDBFactory, 'deleteDatabase'>, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}.`));
    request.onblocked = () => reject(new Error('Close other tabs using Backlog Studio, then try again.'));
  });
}

/** Deletes the old local database(s) and legacy keys. Nothing is migrated. */
export async function removeLegacyData({ idb = indexedDB, storage = localStorage }: LegacyDataDeps = {}): Promise<void> {
  for (const name of legacyDatabaseNames) await deleteDatabase(idb, name);
  for (const key of legacyStorageKeys) storage.removeItem(key);
}
