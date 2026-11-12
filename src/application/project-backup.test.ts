import { describe, expect, it } from 'vitest';
import { copyProjectBackup, parseProjectBackup, serializeProjectBackup, type ProjectBackup } from './project-backup';

const now = '2026-01-01T00:00:00.000Z';
const backup: ProjectBackup = {
  project: { id: 'p', name: 'Project', createdAt: now, updatedAt: now },
  sources: [{ id: 'source', projectId: 'p', name: 'Notes', kind: 'url', mediaType: 'text/plain', text: 'Reference text', selected: true, url: 'https://example.com', createdAt: now, updatedAt: now }],
  items: [
    { id: 'a', projectId: 'p', title: 'Parent', type: 'feature', status: 'draft', description: '', revisions: [], createdAt: now, updatedAt: now },
    { id: 'b', projectId: 'p', title: 'Child', type: 'user-story', status: 'draft', description: '', revisions: [], createdAt: now, updatedAt: now },
  ],
  relationships: [{ sourceId: 'a', targetId: 'b', type: 'parent-child' }],
  sessions: [{
    id: 's', backlogItemId: 'a', status: 'active', forceGeneration: false, createdAt: now, updatedAt: now,
    conversation: [{ id: 'm', role: 'user', content: 'Hello', createdAt: now }],
    pendingQuestions: [{ id: 'q', text: 'Question?', relatedItemId: 'b' }],
  }],
};

describe('project backups', () => {
  it('round-trips an entire project without application configuration', async () => {
    const text = await serializeProjectBackup(backup);
    expect(parseProjectBackup(text)).toEqual(backup);
    expect(text).not.toContain('llm-connection-overrides');
  });

  it('round-trips original binary files', async () => {
    const withFile: ProjectBackup = {
      ...backup,
      sources: [{
        id: 'pdf', projectId: 'p', name: 'file.pdf', kind: 'file', mediaType: 'application/pdf', text: 'Extracted',
        selected: false, file: new Blob([new Uint8Array([0, 1, 128, 255])], { type: 'application/pdf' }),
        createdAt: now, updatedAt: now,
      }],
    };
    const restored = parseProjectBackup(await serializeProjectBackup(withFile));
    const file = restored.sources[0].file!;
    expect(file.type).toBe('application/pdf');
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
    expect([...new Uint8Array(bytes)]).toEqual([0, 1, 128, 255]);
  });

  it('copies identities and all internal references', () => {
    let id = 0;
    const copy = copyProjectBackup(backup, () => `new-${++id}`);
    expect(copy.project.id).not.toBe(backup.project.id);
    expect(copy.items.every((item) => item.projectId === copy.project.id)).toBe(true);
    expect(copy.sources[0].projectId).toBe(copy.project.id);
    expect(copy.relationships[0].sourceId).toBe(copy.items[0].id);
    expect(copy.relationships[0].targetId).toBe(copy.items[1].id);
    expect(copy.sessions[0].backlogItemId).toBe(copy.items[0].id);
    expect(copy.sessions[0].pendingQuestions[0].relatedItemId).toBe(copy.items[1].id);
  });

  it('rejects invalid ownership and dangling references before import', async () => {
    const json = JSON.parse(await serializeProjectBackup(backup));
    json.items[0].projectId = 'different';
    expect(() => parseProjectBackup(JSON.stringify(json))).toThrow(/another project/);
    json.items[0].projectId = 'p';
    json.relationships[0].targetId = 'missing';
    expect(() => parseProjectBackup(JSON.stringify(json))).toThrow(/invalid relationship/);
    json.version = 2;
    expect(() => parseProjectBackup(JSON.stringify(json))).toThrow();
  });
});
