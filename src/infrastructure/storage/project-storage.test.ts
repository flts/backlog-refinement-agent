import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { BacklogDatabase } from './database';
import { inspectLegacyData, openDatabaseAfterLegacyReset } from './bootstrap';
import { IndexedDbRefinementStore } from './IndexedDbRefinementStore';
import { ProjectRepository } from './ProjectRepository';
import { WorkspaceApplicationService } from '../../application/workspace-service';
import { RefinementApplicationService } from '../../application/refinement-service';
import { ProjectBackupRepository } from './ProjectBackupRepository';
import type { BacklogItem } from '../../domain/backlog-item';

const now = '2026-01-01T00:00:00.000Z';
const project = (id: string) => ({ id, name: id, createdAt: now, updatedAt: now });
const item = (id: string, projectId: string): BacklogItem => ({
  id, projectId, type: 'feature', title: id, description: '', status: 'draft', revisions: [], createdAt: now, updatedAt: now,
});
const session = (id: string, backlogItemId: string) => ({
  id, backlogItemId, conversation: [], pendingQuestions: [], status: 'active' as const,
  forceGeneration: false, createdAt: now, updatedAt: now,
});

function name() { return `test-${crypto.randomUUID()}`; }

describe('project persistence', () => {
  it('replaces a project atomically without affecting other projects', async () => {
    const db = new BacklogDatabase(name());
    const projects = new ProjectRepository(db);
    const backups = new ProjectBackupRepository(db);
    await projects.createProject(project('a'));
    await projects.createProject(project('b'));
    await new IndexedDbRefinementStore('a', db).createItem(item('a1', 'a'));
    await new IndexedDbRefinementStore('b', db).createItem(item('b1', 'b'));
    const original = await backups.read('a');
    await expect(backups.write({ ...original, items: [item('b1', 'a')] }, true)).rejects.toThrow();
    expect(await backups.read('a')).toEqual(original);
    expect((await backups.read('b')).items[0].id).toBe('b1');
    const updated = { ...original, project: { ...original.project, name: 'Updated' }, items: [item('a2', 'a')] };
    await backups.write(updated, true);
    expect(await backups.read('a')).toEqual(updated);
    expect((await backups.read('b')).items[0].id).toBe('b1');
    const dbName = db.name;
    db.close();
    await Dexie.delete(dbName);
  });

  it('inspects an absent or empty legacy database without requesting a reset', async () => {
    const dbName = name();
    expect(await inspectLegacyData(dbName)).toMatchObject({ needsConfirmation: false });
    const legacy = new Dexie(dbName);
    legacy.version(1).stores({ backlogItems: 'id', relationships: '++id', sessions: 'id', settings: 'id' });
    await legacy.table('settings').put({ id: 'app', instructions: 'keep' });
    legacy.close();
    const db = new BacklogDatabase(dbName);
    await db.open();
    expect(await db.settings.get('app')).toMatchObject({ instructions: 'keep' });
    db.close();
    await Dexie.delete(dbName);
  });

  it('refuses legacy upgrades without confirmation and preserves settings on confirmed reset', async () => {
    const dbName = name();
    const legacy = new Dexie(dbName);
    legacy.version(1).stores({
      backlogItems: 'id, type, status, updatedAt', relationships: '++id, [sourceId+targetId+type], sourceId, targetId, type',
      sessions: 'id, backlogItemId, status, updatedAt', settings: 'id',
    });
    await legacy.table('backlogItems').add({ id: 'legacy' });
    await legacy.table('sessions').add({ id: 'session' });
    await legacy.table('settings').add({ id: 'app', instructions: 'keep' });
    legacy.close();
    expect(await inspectLegacyData(dbName)).toMatchObject({ needsConfirmation: true, backlogItems: 1, sessions: 1 });
    const unconfirmed = new BacklogDatabase(dbName);
    await expect(unconfirmed.open()).rejects.toThrow(/confirmation/i);
    unconfirmed.close();
    expect(await inspectLegacyData(dbName)).toMatchObject({ needsConfirmation: true, backlogItems: 1 });
    const upgraded = await openDatabaseAfterLegacyReset({ confirmed: true, name: dbName });
    expect(await upgraded.backlogItems.count()).toBe(0);
    expect(await upgraded.sessions.count()).toBe(0);
    expect(await upgraded.settings.get('app')).toMatchObject({ instructions: 'keep' });
    upgraded.close();
    await Dexie.delete(dbName);
  });

  it('keeps items, sessions, relationships and sources scoped and prevents cross-project writes', async () => {
    const db = new BacklogDatabase(name());
    const projects = new ProjectRepository(db);
    await projects.createProject(project('a'));
    await projects.createProject(project('b'));
    const a = new IndexedDbRefinementStore('a', db);
    const b = new IndexedDbRefinementStore('b', db);
    await a.createItem(item('a1', 'a'));
    await a.createItem(item('a2', 'a'));
    await b.createItem(item('b1', 'b'));
    await a.saveSession(session('s-a', 'a1'));
    await a.saveSession(session('s-a2', 'a2'));
    await b.saveSession(session('s-b', 'b1'));
    await b.saveRelationships([{ sourceId: 'b1', targetId: 'b1', type: 'related-to' }]);
    await a.saveRelationships([{ sourceId: 'a1', targetId: 'a2', type: 'related-to' }]);
    const workspace = new WorkspaceApplicationService('a', a);
    await expect(workspace.createItem('feature', 'wrong parent', 'b1')).rejects.toThrow();
    expect(await a.listItems()).toHaveLength(2);
    const child = await workspace.createItem('user-story', 'child', 'a1');
    expect(child.projectId).toBe('a');
    expect(await a.listRelationships()).toContainEqual(expect.objectContaining({ sourceId: 'a1', targetId: child.id, type: 'parent-child' }));
    expect(await a.listSessionsForItem(child.id)).toHaveLength(1);
    const refinement = new RefinementApplicationService({
      store: a,
      provider: { generateAssessment: async () => ({}), generateDecomposition: async () => ({}) },
      ids: { nextId: () => 'generated-child' },
    });
    const [generated] = await refinement.acceptProposal({
      id: 'proposal', kind: 'decomposition', parentItemId: 'a1', generatedAt: now, rationale: 'Split work',
      children: [{ proposalId: 'child', type: 'user-story', title: 'generated', description: '' }], relationships: [],
    });
    expect(generated.projectId).toBe('a');
    expect(await a.getItem('generated-child')).toBeDefined();
    expect(await a.listRelationships()).toContainEqual(expect.objectContaining({ sourceId: 'a1', targetId: 'generated-child', type: 'parent-child' }));
    await expect(workspace.deleteSessionForItem('a1', 's-a2')).rejects.toThrow();
    await expect(workspace.deleteSessionForItem('a1', 's-b')).rejects.toThrow();
    await workspace.deleteSessionForItem('a1', 's-a');
    expect(await a.getSession('s-a')).toBeUndefined();
    expect(await a.getSession('s-a2')).toBeDefined();
    expect(await a.getItem('b1')).toBeUndefined();
    expect(await a.getSession('s-b')).toBeUndefined();
    expect(await a.listSessionsForItem('b1')).toEqual([]);
    await expect(a.saveRelationships([{ sourceId: 'a1', targetId: 'b1', type: 'related-to' }])).rejects.toThrow();
    await expect(a.saveSession(session('s-b', 'a1'))).rejects.toThrow();
    await expect(a.saveItem(item('b1', 'a'))).rejects.toThrow();
    expect(await b.listRelationships()).toHaveLength(1);
    const source = { id: 'source', projectId: 'a', name: 'file', kind: 'file' as const, mediaType: 'text/plain', text: 'text', selected: true, file: new Blob(['text']), createdAt: now, updatedAt: now };
    await projects.saveSource(source);
    await expect(projects.saveSource({ ...source, projectId: 'b' })).rejects.toThrow();
    expect(await projects.getSource('b', 'source')).toBeUndefined();
    await a.deleteItemAndReferences('b1');
    expect(await b.getItem('b1')).toBeDefined();
    await projects.deleteProject('a');
    expect(await projects.listSources('a')).toEqual([]);
    expect(await b.getItem('b1')).toBeDefined();
    expect(await b.getSession('s-b')).toBeDefined();
    expect(await b.listRelationships()).toHaveLength(1);
    const dbName = db.name;
    db.close();
    await Dexie.delete(dbName);
  });
});
