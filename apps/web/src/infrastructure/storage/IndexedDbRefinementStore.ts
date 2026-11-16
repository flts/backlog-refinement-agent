import Dexie, { type Table, type Transaction } from 'dexie';
import { BacklogItemSchema, type BacklogItem } from '../../domain/backlog-item';
import type { RefinementSession } from '../../domain/refinement-session';
import type { BacklogRelationship } from '../../domain/relationship';
import type { RefinementStore } from '../../application/ports';
import { BacklogDatabase, backlogDatabase } from './database';

export class IndexedDbRefinementStore implements RefinementStore {
  constructor(readonly projectId: string, private readonly db: BacklogDatabase = backlogDatabase, private readonly tx?: Transaction) {
    if (!projectId.trim()) throw new Error('A project ID is required.');
  }

  private get items(): Table<BacklogItem, string> { return this.tx ? this.tx.table('backlogItems') : this.db.backlogItems; }
  private get relationships(): Table<BacklogRelationship, number> { return this.tx ? this.tx.table('relationships') : this.db.relationships; }
  private get sessions(): Table<RefinementSession, string> { return this.tx ? this.tx.table('sessions') : this.db.sessions; }
  private get projects() { return this.tx ? this.tx.table('projects') : this.db.projects; }

  async getItem(id: string): Promise<BacklogItem | undefined> {
    const stored = await this.items.get(id);
    return stored?.projectId === this.projectId ? BacklogItemSchema.parse(stored) : undefined;
  }

  async listItems(): Promise<BacklogItem[]> {
    const stored = await this.items.where('projectId').equals(this.projectId).sortBy('updatedAt');
    return stored.reverse().map((item) => BacklogItemSchema.parse(item));
  }

  private async writeItem(item: BacklogItem, create: boolean): Promise<void> {
    if (!this.tx) return this.transaction((store) => create ? store.createItem(item) : store.saveItem(item));
    if (item.projectId !== this.projectId) throw new Error('Backlog item belongs to another project.');
    if (!await this.projects.get(this.projectId)) throw new Error('Project not found.');
    const existing = await this.items.get(item.id);
    if (existing && existing.projectId !== this.projectId) throw new Error('Backlog item belongs to another project.');
    if (create) await this.items.add(item);
    else {
      if (!existing) throw new Error('Backlog item not found.');
      await this.items.put(item);
    }
  }

  saveItem(item: BacklogItem): Promise<void> { return this.writeItem(item, false); }
  createItem(item: BacklogItem): Promise<void> { return this.writeItem(item, true); }

  async listRelationships(): Promise<BacklogRelationship[]> {
    const ids = new Set((await this.listItems()).map((item) => item.id));
    return (await this.relationships.toArray()).filter(({ sourceId, targetId }) => ids.has(sourceId) && ids.has(targetId));
  }

  async saveRelationships(relationships: readonly BacklogRelationship[]): Promise<void> {
    if (!this.tx) return this.transaction((store) => store.saveRelationships(relationships));
    const ids = new Set((await this.listItems()).map((item) => item.id));
    if (relationships.some(({ sourceId, targetId }) => !ids.has(sourceId) || !ids.has(targetId))) {
      throw new Error('Relationship endpoints must belong to this project.');
    }
    for (const id of ids) await this.relationships.where('sourceId').equals(id).delete();
    if (relationships.length) await this.relationships.bulkAdd([...relationships]);
  }

  async getSession(id: string): Promise<RefinementSession | undefined> {
    const session = await this.sessions.get(id);
    return session && await this.getItem(session.backlogItemId) ? session : undefined;
  }

  async saveSession(session: RefinementSession): Promise<void> {
    if (!this.tx) return this.transaction((store) => store.saveSession(session));
    if (!await this.getItem(session.backlogItemId)) throw new Error('Session item does not belong to this project.');
    const existing = await this.sessions.get(session.id);
    if (existing && existing.backlogItemId !== session.backlogItemId) throw new Error('Session belongs to another backlog item.');
    await this.sessions.put(session);
  }

  async listSessionsForItem(itemId: string): Promise<RefinementSession[]> {
    if (!await this.getItem(itemId)) return [];
    return (await this.sessions.where('backlogItemId').equals(itemId).sortBy('updatedAt')).reverse();
  }

  async listSessions(): Promise<RefinementSession[]> {
    const ids = new Set((await this.listItems()).map((item) => item.id));
    return (await this.sessions.orderBy('updatedAt').reverse().toArray()).filter((session) => ids.has(session.backlogItemId));
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.tx) return this.transaction((store) => store.deleteSession(id));
    if (await this.getSession(id)) await this.sessions.delete(id);
  }

  async deleteItemAndReferences(id: string): Promise<void> {
    if (!this.tx) return this.transaction((store) => store.deleteItemAndReferences(id));
    if (!await this.getItem(id)) return;
    await this.items.delete(id);
    await this.relationships.where('sourceId').equals(id).delete();
    await this.relationships.where('targetId').equals(id).delete();
    await this.sessions.where('backlogItemId').equals(id).delete();
  }

  transaction<T>(work: (store: RefinementStore) => Promise<T>): Promise<T> {
    if (this.tx) return work(this);
    return this.db.transaction('rw', this.db.projects, this.db.backlogItems, this.db.relationships, this.db.sessions, () => {
      const tx = Dexie.currentTransaction;
      if (!tx) throw new Error('Missing IndexedDB transaction.');
      return Dexie.waitFor(work(new IndexedDbRefinementStore(this.projectId, this.db, tx)));
    });
  }
}
