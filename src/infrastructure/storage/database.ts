import Dexie, { type Table } from 'dexie';
import type { BacklogItem } from '../../domain/backlog-item';
import type { BacklogRelationship } from '../../domain/relationship';
import type { RefinementSession } from '../../domain/refinement-session';
import type { BacklogItemType } from '../../domain/backlog-item';

export interface StoredAppSettings {
  id: 'app';
  instructions: string;
  templates: Record<BacklogItemType, string>;
  principles: string;
  typeInstructions: Record<BacklogItemType, string>;
}

export class BacklogDatabase extends Dexie {
  backlogItems!: Table<BacklogItem, string>;
  relationships!: Table<BacklogRelationship, number>;
  sessions!: Table<RefinementSession, string>;
  settings!: Table<StoredAppSettings, 'app'>;

  constructor(name = 'backlog-refinement-agent') {
    super(name);
    this.version(1).stores({
      backlogItems: 'id, type, status, updatedAt',
      relationships: '++id, [sourceId+targetId+type], sourceId, targetId, type',
      sessions: 'id, backlogItemId, status, updatedAt',
      settings: 'id',
    });
  }
}

export const backlogDatabase = new BacklogDatabase();
