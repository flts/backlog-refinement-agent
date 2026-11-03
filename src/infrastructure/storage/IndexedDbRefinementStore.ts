import type { Table } from 'dexie';
import { BacklogItemSchema, type BacklogItem } from '../../domain/backlog-item';
import type { RefinementSession } from '../../domain/refinement-session';
import type { BacklogRelationship } from '../../domain/relationship';
import type { RefinementStore } from '../../application/ports';
import { BacklogDatabase, backlogDatabase } from './database';

export class IndexedDbRefinementStore implements RefinementStore {
  constructor(private readonly db: BacklogDatabase = backlogDatabase) {}

  async getItem(id: string): Promise<BacklogItem | undefined> {
    const stored = await this.db.backlogItems.get(id);
    return stored && BacklogItemSchema.parse(stored);
  }

  async listItems(): Promise<BacklogItem[]> {
    const stored = await this.db.backlogItems.orderBy('updatedAt').reverse().toArray();
    return stored.map((item) => BacklogItemSchema.parse(item));
  }

  async saveItem(item: BacklogItem): Promise<void> {
    await this.db.backlogItems.put(item);
  }

  async createItem(item: BacklogItem): Promise<void> {
    await this.db.backlogItems.add(item);
  }

  listRelationships(): Promise<BacklogRelationship[]> {
    return this.db.relationships.toArray();
  }

  async saveRelationships(relationships: readonly BacklogRelationship[]): Promise<void> {
    await this.db.transaction('rw', this.db.relationships, async () => {
      await this.db.relationships.clear();
      if (relationships.length > 0) {
        await this.db.relationships.bulkAdd([...relationships]);
      }
    });
  }

  getSession(id: string): Promise<RefinementSession | undefined> {
    return this.db.sessions.get(id);
  }

  async saveSession(session: RefinementSession): Promise<void> {
    await this.db.sessions.put(session);
  }

  async listSessionsForItem(itemId: string): Promise<RefinementSession[]> {
    return (await this.db.sessions.where('backlogItemId').equals(itemId).sortBy('updatedAt')).reverse();
  }

  async listSessions(): Promise<RefinementSession[]> {
    return this.db.sessions.orderBy('updatedAt').reverse().toArray();
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.sessions.delete(id);
  }

  async deleteItemAndReferences(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.backlogItems, this.db.relationships, this.db.sessions, async () => {
      await this.db.backlogItems.delete(id);
      await this.db.relationships.where('sourceId').equals(id).delete();
      await this.db.relationships.where('targetId').equals(id).delete();
      await this.db.sessions.where('backlogItemId').equals(id).delete();
    });
  }

  transaction<T>(work: (store: RefinementStore) => Promise<T>): Promise<T> {
    return this.db.transaction(
      'rw',
      this.db.backlogItems as Table<BacklogItem, string>,
      this.db.relationships as Table<BacklogRelationship, number>,
      this.db.sessions as Table<RefinementSession, string>,
      () => work(this),
    );
  }
}
