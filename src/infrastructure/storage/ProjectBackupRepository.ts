import type { ProjectBackup } from '../../application/project-backup';
import { BacklogDatabase, backlogDatabase } from './database';

export class ProjectBackupRepository {
  constructor(private readonly db: BacklogDatabase = backlogDatabase) {}

  async read(projectId: string): Promise<ProjectBackup> {
    return this.db.transaction('r', this.db.projects, this.db.sources, this.db.backlogItems,
      this.db.relationships, this.db.sessions, async () => {
        const project = await this.db.projects.get(projectId);
        if (!project) throw new Error('Project not found.');
        const items = await this.db.backlogItems.where('projectId').equals(projectId).toArray();
        const ids = new Set(items.map((item) => item.id));
        const relationships = (await this.db.relationships.toArray())
          .filter((relationship) => ids.has(relationship.sourceId) && ids.has(relationship.targetId))
          .map(({ sourceId, targetId, type }) => ({ sourceId, targetId, type }));
        const sessions = (await this.db.sessions.toArray()).filter((session) => ids.has(session.backlogItemId));
        const sources = await this.db.sources.where('projectId').equals(projectId).toArray();
        return { project, items, relationships, sessions, sources };
      });
  }

  async write(backup: ProjectBackup, replace: boolean): Promise<void> {
    await this.db.transaction('rw', this.db.projects, this.db.sources, this.db.backlogItems,
      this.db.relationships, this.db.sessions, async () => {
        const existing = await this.db.projects.get(backup.project.id);
        if (existing && !replace) throw new Error('A project with this ID already exists.');
        if (!existing && replace) throw new Error('The project to replace no longer exists.');
        if (existing) {
          const itemIds = await this.db.backlogItems.where('projectId').equals(existing.id).primaryKeys();
          for (const id of itemIds) {
            await this.db.relationships.where('sourceId').equals(id).delete();
            await this.db.relationships.where('targetId').equals(id).delete();
            await this.db.sessions.where('backlogItemId').equals(id).delete();
          }
          await this.db.backlogItems.bulkDelete(itemIds);
          await this.db.sources.where('projectId').equals(existing.id).delete();
          await this.db.projects.delete(existing.id);
        }
        await this.db.projects.add(backup.project);
        await this.db.sources.bulkAdd(backup.sources);
        await this.db.backlogItems.bulkAdd(backup.items);
        await this.db.relationships.bulkAdd(backup.relationships);
        await this.db.sessions.bulkAdd(backup.sessions);
      });
  }
}
