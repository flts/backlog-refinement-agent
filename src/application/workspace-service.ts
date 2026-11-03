import { BacklogItemSchema, type BacklogItem, type BacklogItemType } from '../domain/backlog-item';
import { addRelationship, removeRelationship, transitionItemStatus } from '../domain/services';
import { RefinementSessionSchema, type PendingQuestion, type RefinementSession } from '../domain/refinement-session';
import type { BacklogRelationship, RelationshipType } from '../domain/relationship';
import type { RefinementStore } from './ports';

const itemTitles: Record<BacklogItemType, string> = {
  capability: 'Untitled Capability',
  feature: 'Untitled Feature',
  'user-story': 'Untitled User Story',
  enabler: 'Untitled Enabler',
};

function createId(): string {
  return crypto.randomUUID();
}

function timestamp(): string {
  return new Date().toISOString();
}

export class WorkspaceApplicationService {
  constructor(private readonly store: RefinementStore) {}

  listItems(): Promise<BacklogItem[]> {
    return this.store.listItems();
  }

  getItem(id: string): Promise<BacklogItem | undefined> {
    return this.store.getItem(id);
  }

  getSession(id: string): Promise<RefinementSession | undefined> {
    return this.store.getSession(id);
  }

  listRelationships(): Promise<BacklogRelationship[]> {
    return this.store.listRelationships();
  }

  listSessionsForItem(itemId: string): Promise<RefinementSession[]> {
    return this.store.listSessionsForItem(itemId);
  }

  async getOrCreateSession(itemId: string): Promise<RefinementSession> {
    return this.store.transaction(async (store) => {
      const sessions = await store.listSessionsForItem(itemId);
      const active = sessions.find((session) => session.status === 'active');
      if (active) return active;
      const item = await store.getItem(itemId);
      if (!item) throw new Error('Cannot create a refinement session for a missing backlog item.');
      const now = timestamp();
      const created = RefinementSessionSchema.parse({
        id: createId(), backlogItemId: itemId, conversation: [], pendingQuestions: [],
        status: 'active', forceGeneration: false, createdAt: now, updatedAt: now,
      });
      await store.saveSession(created);
      return created;
    });
  }

  async createSession(itemId: string): Promise<RefinementSession> {
    const item = await this.store.getItem(itemId);
    if (!item) throw new Error('Cannot create a refinement session for a missing backlog item.');
    const now = timestamp();
    const session = RefinementSessionSchema.parse({
      id: createId(),
      backlogItemId: itemId,
      conversation: [],
      pendingQuestions: [],
      status: 'active',
      forceGeneration: false,
      createdAt: now,
      updatedAt: now,
    });
    await this.store.saveSession(session);
    return session;
  }

  async createItem(type: BacklogItemType, title = itemTitles[type], parentId?: string): Promise<BacklogItem> {
    const now = timestamp();
    const item = BacklogItemSchema.parse({
      id: createId(),
      type,
      title,
      description: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    await this.store.transaction(async (store) => {
      await store.createItem(item);
      if (parentId) {
        const parent = await store.getItem(parentId);
        if (!parent) throw new Error('Cannot attach a child to a missing parent item.');
        const relationships = await store.listRelationships();
        const updated = addRelationship(
          [...await store.listItems()],
          relationships,
          { sourceId: parentId, targetId: item.id, type: 'parent-child' },
        );
        await store.saveRelationships(updated);
      }
      const createdAt = timestamp();
      await store.saveSession(RefinementSessionSchema.parse({
        id: createId(),
        backlogItemId: item.id,
        conversation: [],
        pendingQuestions: [],
        status: 'active',
        forceGeneration: false,
        createdAt,
        updatedAt: createdAt,
      }));
    });

    return item;
  }

  async updateItem(item: BacklogItem): Promise<BacklogItem> {
    const current = await this.store.getItem(item.id);
    if (!current) throw new Error('Cannot update a missing backlog item.');
    const next = item.status === current.status
      ? { ...item, updatedAt: timestamp() }
      : transitionItemStatus({ ...item, status: current.status }, item.status, timestamp());
    const validated = BacklogItemSchema.parse(next);
    await this.store.saveItem(validated);
    return validated;
  }

  async setForceGeneration(sessionId: string, value: boolean): Promise<RefinementSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('Refinement session not found.');
    const updated = RefinementSessionSchema.parse({
      ...session,
      forceGeneration: value,
      updatedAt: timestamp(),
    });
    await this.store.saveSession(updated);
    return updated;
  }

  async addAgentMessage(sessionId: string, content: string, questions: readonly PendingQuestion[] = []): Promise<RefinementSession> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('Refinement session not found.');
    const now = timestamp();
    const updated = RefinementSessionSchema.parse({
      ...session,
      conversation: [...session.conversation, {
        id: createId(), role: 'agent', content, createdAt: now,
      }],
      pendingQuestions: [...questions],
      updatedAt: now,
    });
    await this.store.saveSession(updated);
    return updated;
  }

  async linkItems(sourceId: string, targetId: string, type: RelationshipType): Promise<void> {
    await this.store.transaction(async (store) => {
      const [items, relationships] = await Promise.all([store.listItems(), store.listRelationships()]);
      await store.saveRelationships(addRelationship(items, relationships, { sourceId, targetId, type }));
    });
  }

  async unlinkItems(sourceId: string, targetId: string, type: RelationshipType): Promise<void> {
    await this.store.transaction(async (store) => {
      const relationships = await store.listRelationships();
      await store.saveRelationships(removeRelationship(relationships, sourceId, targetId, type));
    });
  }

  async deleteItemAndReferences(itemId: string): Promise<void> {
    await this.store.deleteItemAndReferences(itemId);
  }
}
