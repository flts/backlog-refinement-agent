import { z } from 'zod';
import { BacklogItemSchema } from '../domain/backlog-item';
import { BacklogRelationshipSchema } from '../domain/relationship';
import { RefinementSessionSchema } from '../domain/refinement-session';
import { ProjectSchema, ProjectSourceSchema, type Project, type ProjectSource } from '../domain/project';
import { addRelationship } from '../domain/services';

const maxBackupBytes = 50 * 1024 * 1024;
const maxFileBytes = 20 * 1024 * 1024;
const encodedFileSchema = z.object({
  type: z.string(),
  data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

const backupSourceSchema = ProjectSourceSchema.omit({ file: true }).extend({
  file: encodedFileSchema.optional(),
});

const backupSchema = z.object({
  format: z.literal('backlog-refinement-project'),
  version: z.literal(1),
  project: ProjectSchema,
  sources: z.array(backupSourceSchema),
  items: z.array(BacklogItemSchema),
  relationships: z.array(BacklogRelationshipSchema),
  sessions: z.array(RefinementSessionSchema),
}).strict();

export interface ProjectBackup {
  project: Project;
  sources: ProjectSource[];
  items: z.infer<typeof BacklogItemSchema>[];
  relationships: z.infer<typeof BacklogRelationshipSchema>[];
  sessions: z.infer<typeof RefinementSessionSchema>[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBlob(encoded: { type: string; data: string }): Blob {
  const binary = atob(encoded.data);
  if (binary.length > maxFileBytes) throw new Error('A project file exceeds the 20 MiB limit.');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: encoded.type });
}

function readBlob(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Could not read the project file.'));
    };
    reader.onerror = () => reject(new Error('Could not read the project file.', { cause: reader.error }));
    reader.readAsArrayBuffer(file);
  });
}

function requireUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} IDs in project backup.`);
}

function validateReferences(backup: ProjectBackup): void {
  const projectId = backup.project.id;
  requireUnique(backup.items.map((item) => item.id), 'item');
  requireUnique(backup.sources.map((source) => source.id), 'source');
  requireUnique(backup.sessions.map((session) => session.id), 'session');
  const ids = new Set(backup.items.map((item) => item.id));
  if (backup.items.some((item) => item.projectId !== projectId) ||
      backup.sources.some((source) => source.projectId !== projectId)) {
    throw new Error('The project backup contains data belonging to another project.');
  }
  for (const source of backup.sources) {
    if (source.kind === 'file' && !source.file) throw new Error('A project file is missing its original content.');
    if (source.kind === 'url') {
      let url: URL;
      try { url = new URL(source.url ?? ''); }
      catch { throw new Error('A project reference has an invalid URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('A project reference must use an HTTP(S) URL without credentials.');
      }
    }
  }
  if (backup.relationships.some(({ sourceId, targetId }) => !ids.has(sourceId) || !ids.has(targetId) || sourceId === targetId)) {
    throw new Error('The project backup contains an invalid relationship.');
  }
  if (backup.sessions.some((session) => !ids.has(session.backlogItemId) ||
      session.pendingQuestions.some((question) => question.relatedItemId && !ids.has(question.relatedItemId)))) {
    throw new Error('The project backup contains an invalid session reference.');
  }
  let relationships: ProjectBackup['relationships'] = [];
  for (const relationship of backup.relationships) {
    relationships = addRelationship(backup.items, relationships, relationship);
  }
}

export async function serializeProjectBackup(backup: ProjectBackup): Promise<string> {
  validateReferences(backup);
  const sources = await Promise.all(backup.sources.map(async ({ file, ...source }) => {
    if (file && file.size > maxFileBytes) throw new Error('A project file exceeds the 20 MiB limit.');
    return {
      ...source,
      ...(file ? { file: { type: file.type, data: bytesToBase64(new Uint8Array(await readBlob(file))) } } : {}),
    };
  }));
  const json = JSON.stringify(backupSchema.parse({
    format: 'backlog-refinement-project', version: 1, ...backup, sources,
  }));
  if (new Blob([json]).size > maxBackupBytes) throw new Error('Project backup exceeds the 50 MiB limit.');
  return json;
}

export function parseProjectBackup(text: string): ProjectBackup {
  if (new Blob([text]).size > maxBackupBytes) throw new Error('Project backup exceeds the 50 MiB limit.');
  const parsed = backupSchema.parse(JSON.parse(text));
  const backup: ProjectBackup = {
    project: parsed.project,
    items: parsed.items,
    relationships: parsed.relationships,
    sessions: parsed.sessions,
    sources: parsed.sources.map(({ file, ...source }) => ProjectSourceSchema.parse({
      ...source, ...(file ? { file: base64ToBlob(file) } : {}),
    })),
  };
  validateReferences(backup);
  return backup;
}

export function copyProjectBackup(backup: ProjectBackup, nextId: () => string = () => crypto.randomUUID()): ProjectBackup {
  validateReferences(backup);
  const projectId = nextId();
  const itemIds = new Map(backup.items.map((item) => [item.id, nextId()]));
  const copy: ProjectBackup = {
    project: { ...backup.project, id: projectId, name: `${backup.project.name} (copy)` },
    sources: backup.sources.map((source) => ({ ...source, id: nextId(), projectId })),
    items: backup.items.map((item) => ({ ...item, id: itemIds.get(item.id)!, projectId })),
    relationships: backup.relationships.map((relationship) => ({
      ...relationship, sourceId: itemIds.get(relationship.sourceId)!, targetId: itemIds.get(relationship.targetId)!,
    })),
    sessions: backup.sessions.map((session) => ({
      ...session,
      id: nextId(),
      backlogItemId: itemIds.get(session.backlogItemId)!,
      conversation: session.conversation.map((message) => ({ ...message, id: nextId() })),
      pendingQuestions: session.pendingQuestions.map((question) => ({
        ...question, id: nextId(),
        ...(question.relatedItemId ? { relatedItemId: itemIds.get(question.relatedItemId)! } : {}),
      })),
    })),
  };
  validateReferences(copy);
  return copy;
}
