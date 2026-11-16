import Dexie from 'dexie';
import { ProjectSchema, ProjectSourceSchema, type Project, type ProjectSource } from '../../domain/project';
import { BacklogDatabase, backlogDatabase } from './database';

export class ProjectRepository {
  constructor(private readonly db: BacklogDatabase = backlogDatabase) {}

  async listProjects(): Promise<Project[]> {
    return (await this.db.projects.orderBy('updatedAt').reverse().toArray()).map((value) => ProjectSchema.parse(value));
  }

  async getProject(id: string): Promise<Project | undefined> {
    const project = await this.db.projects.get(id);
    return project && ProjectSchema.parse(project);
  }

  async createProject(project: Project): Promise<Project> {
    const validated = ProjectSchema.parse(project);
    await this.db.projects.add(validated);
    return validated;
  }

  async updateProject(project: Project): Promise<Project> {
    const validated = ProjectSchema.parse(project);
    await this.db.transaction('rw', this.db.projects, () => {
      const projects = Dexie.currentTransaction!.table('projects');
      return Dexie.waitFor((async () => {
        if (!await projects.get(validated.id)) throw new Error('Project not found.');
        await projects.put(validated);
      })());
    });
    return validated;
  }

  async deleteProject(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.projects, this.db.sources, this.db.backlogItems,
      this.db.relationships, this.db.sessions, () => {
        const tx = Dexie.currentTransaction!;
        const itemsTable = tx.table('backlogItems');
        const relationships = tx.table('relationships');
        const sessions = tx.table('sessions');
        const sources = tx.table('sources');
        const projects = tx.table('projects');
        return Dexie.waitFor((async () => {
          const items = await itemsTable.where('projectId').equals(id).primaryKeys();
          for (const itemId of items) {
            await relationships.where('sourceId').equals(itemId).delete();
            await relationships.where('targetId').equals(itemId).delete();
            await sessions.where('backlogItemId').equals(itemId).delete();
          }
          await itemsTable.bulkDelete(items);
          await sources.where('projectId').equals(id).delete();
          await projects.delete(id);
        })());
      });
  }

  async listSources(projectId: string): Promise<ProjectSource[]> {
    return (await this.db.sources.where('projectId').equals(projectId).toArray())
      .map((source) => ProjectSourceSchema.parse(source));
  }

  async getSource(projectId: string, id: string): Promise<ProjectSource | undefined> {
    const source = await this.db.sources.get(id);
    return source?.projectId === projectId ? ProjectSourceSchema.parse(source) : undefined;
  }

  async saveSource(source: ProjectSource): Promise<ProjectSource> {
    const validated = ProjectSourceSchema.parse(source);
    await this.db.transaction('rw', this.db.projects, this.db.sources, () => {
      const tx = Dexie.currentTransaction!;
      const projects = tx.table('projects');
      const sources = tx.table('sources');
      return Dexie.waitFor((async () => {
        if (!await projects.get(validated.projectId)) throw new Error('Project not found.');
        const current = await sources.get(validated.id);
        if (current && current.projectId !== validated.projectId) throw new Error('Source belongs to another project.');
        await sources.put(validated);
      })());
    });
    return validated;
  }

  async deleteSource(projectId: string, id: string): Promise<void> {
    await this.db.transaction('rw', this.db.sources, () => {
      const sources = Dexie.currentTransaction!.table('sources');
      return Dexie.waitFor((async () => {
        const source = await sources.get(id);
        if (source?.projectId === projectId) await sources.delete(id);
      })());
    });
  }
}
