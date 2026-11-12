import { BacklogDatabase, databaseName } from './database';

export interface LegacyDataInspection {
  needsConfirmation: boolean;
  backlogItems: number;
  relationships: number;
  sessions: number;
}

/**
 * Inspect without opening Dexie or upgrading the database. The upgrade itself
 * checks again in its version-change transaction, so this is not a reset grant.
 */
export function inspectLegacyData(name = databaseName): Promise<LegacyDataInspection> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let absent = false;
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onerror = () => {
      if (absent) resolve({ needsConfirmation: false, backlogItems: 0, relationships: 0, sessions: 0 });
      else reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      const empty = { needsConfirmation: false, backlogItems: 0, relationships: 0, sessions: 0 };
      if (db.version >= 20) {
        db.close();
        resolve(empty);
        return;
      }
      const names = (['backlogItems', 'relationships', 'sessions'] as const)
        .filter((table) => db.objectStoreNames.contains(table));
      if (!names.length) {
        db.close();
        resolve(empty);
        return;
      }
      const transaction = db.transaction(names, 'readonly');
      const counts = { ...empty };
      for (const table of names) {
        const count = transaction.objectStore(table).count();
        count.onsuccess = () => { counts[table] = count.result; };
      }
      transaction.oncomplete = () => {
        db.close();
        counts.needsConfirmation = counts.backlogItems + counts.relationships + counts.sessions > 0;
        resolve(counts);
      };
      transaction.onabort = transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

/** Call only after the user has explicitly approved discarding legacy backlog data. */
export async function openDatabaseAfterLegacyReset(
  options: { confirmed: true; name?: string; onBlocked?: () => void },
): Promise<BacklogDatabase> {
  if (options.confirmed !== true) throw new Error('Legacy reset requires explicit confirmation.');
  const db = new BacklogDatabase(options.name, { confirmLegacyReset: true });
  if (options.onBlocked) db.on('blocked', options.onBlocked);
  try {
    await db.open();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
