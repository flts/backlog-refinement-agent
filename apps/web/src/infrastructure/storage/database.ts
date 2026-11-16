import Dexie, { type Table } from 'dexie';
import type { BacklogItem } from '../../domain/backlog-item';
import type { BacklogRelationship } from '../../domain/relationship';
import type { RefinementSession } from '../../domain/refinement-session';
import type { BacklogItemType } from '../../domain/backlog-item';
import type { Project, ProjectSource } from '../../domain/project';

export const databaseName = 'backlog-refinement-agent';

export class LegacyDataConfirmationRequiredError extends Error {
  constructor() {
    super('Legacy backlog data must be discarded with explicit confirmation before upgrading.');
    this.name = 'LegacyDataConfirmationRequiredError';
  }
}

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
  projects!: Table<Project, string>;
  sources!: Table<ProjectSource, string>;

  constructor(name = databaseName, options: { confirmLegacyReset?: boolean } = {}) {
    super(name);
    this.version(1).stores({
      backlogItems: 'id, type, status, updatedAt',
      relationships: '++id, [sourceId+targetId+type], sourceId, targetId, type',
      sessions: 'id, backlogItemId, status, updatedAt',
      settings: 'id',
    });
    this.version(2).stores({
      backlogItems: 'id, projectId, type, status, updatedAt',
      relationships: '++id, [sourceId+targetId+type], sourceId, targetId, type',
      sessions: 'id, backlogItemId, status, updatedAt',
      settings: 'id',
      projects: 'id, updatedAt',
      sources: 'id, projectId',
    }).upgrade(async (transaction) => {
      const tables = ['backlogItems', 'relationships', 'sessions'] as const;
      const counts = await Promise.all(tables.map((name) => transaction.table(name).count()));
      if (counts.some((count) => count > 0)) {
        if (!options.confirmLegacyReset) throw new LegacyDataConfirmationRequiredError();
        await Promise.all(tables.map((name) => transaction.table(name).clear()));
      }
    });
  }
}

export const backlogDatabase = new BacklogDatabase();
