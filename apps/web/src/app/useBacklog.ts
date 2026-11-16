import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backlogKeys, isVersionConflict, useChangeItemStatus, useCreateItem, useDeleteItem, useItem, useItems, useRestoreRevision, useRevisions, useUpdateItem,
  type Item, type ItemChanges, type ItemStatus, type ItemType,
} from '../api';
import { updateChecklistLine } from '../domain/document';
import { RefinementSessionSchema, type RefinementSession } from '../domain/refinement-session';
import { itemTypeLabel } from './labels';
import { errorText, type Notifications } from './useNotifications';

const autosaveDelayMs = 800;

/** Unsaved edits, based on the server version the user saw when starting to type (sent as `If-Match`). */
type Draft = { title?: string; document?: string; baseVersion: number };

function newSession(itemId: string): RefinementSession {
  const now = new Date().toISOString();
  return RefinementSessionSchema.parse({
    id: crypto.randomUUID(), backlogItemId: itemId, conversation: [], pendingQuestions: [], status: 'active', forceGeneration: false, createdAt: now, updatedAt: now,
  });
}

/**
 * The backlog of one project, served by backlog-api. Edits are autosaved with `If-Match: <version>`; a 409 pauses autosave for
 * that item and shows the "someone else changed this item" notice with a Reload action (the conflict dialog is `fe-collab`).
 * Refinement sessions are kept in memory only until the agent-service threads replace them.
 */
export function useBacklog(notifications: Notifications, projectId: string) {
  const { setError, setNotice, report } = notifications;
  const queryClient = useQueryClient();
  const itemsQuery = useItems(projectId);
  const items = itemsQuery.data ?? [];
  const [pickedId, setPickedId] = useState<string>();
  const selectedId = items.some((entry) => entry.id === pickedId) ? pickedId : items[0]?.id;
  const itemQuery = useItem(projectId, selectedId);
  const revisionsQuery = useRevisions(projectId, selectedId);
  const createItemMutation = useCreateItem(projectId);
  const updateItemMutation = useUpdateItem(projectId);
  const statusMutation = useChangeItemStatus(projectId);
  const deleteItemMutation = useDeleteItem(projectId);
  const restoreMutation = useRestoreRevision(projectId);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef<Record<string, Draft>>({});
  const conflicts = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [saving, setSaving] = useState(0);

  const [sessionsByItem, setSessionsByItem] = useState<Record<string, RefinementSession[]>>({});
  const [activeSessionIds, setActiveSessionIds] = useState<Record<string, string>>({});

  const serverItem = itemQuery.data && itemQuery.data.id === selectedId ? itemQuery.data : undefined;
  const draft = selectedId ? drafts[selectedId] : undefined;
  const selectedItem: Item | undefined = serverItem && { ...serverItem, title: draft?.title ?? serverItem.title, document: draft?.document ?? serverItem.document };
  const selectedSummary = items.find((entry) => entry.id === selectedId);
  const parentItem = selectedSummary?.parentId ? items.find((entry) => entry.id === selectedSummary.parentId) : undefined;
  const revisions = revisionsQuery.data ?? [];
  const sessions = (selectedId && sessionsByItem[selectedId]) || [];
  const session = sessions.find((entry) => entry.id === (selectedId && activeSessionIds[selectedId])) ?? sessions[0];

  useEffect(() => {
    if (selectedId && !sessionsByItem[selectedId]) setSessionsByItem((current) => current[selectedId] ? current : { ...current, [selectedId]: [newSession(selectedId)] });
  }, [selectedId, sessionsByItem]);

  const setDraftsBoth = (next: Record<string, Draft>) => { draftsRef.current = next; setDrafts(next); };
  const dropDraft = (itemId: string) => {
    window.clearTimeout(timers.current.get(itemId));
    timers.current.delete(itemId);
    const { [itemId]: _removed, ...rest } = draftsRef.current;
    setDraftsBoth(rest);
  };
  const latestItem = (itemId: string) => queryClient.getQueryData<Item>(backlogKeys.item(projectId, itemId));

  const reload = (itemId?: string) => {
    if (itemId) { conflicts.current.delete(itemId); dropDraft(itemId); }
    void queryClient.invalidateQueries({ queryKey: backlogKeys.project(projectId) });
  };

  async function saveDraft(itemId: string): Promise<boolean> {
    window.clearTimeout(timers.current.get(itemId));
    timers.current.delete(itemId);
    const pending = draftsRef.current[itemId];
    const base = latestItem(itemId);
    if (!pending) return true;
    if (conflicts.current.has(itemId) || !base) return false;
    const changes: ItemChanges = {};
    // A blank title is kept in the field until the user types one; it is never sent.
    if (pending.title?.trim() && pending.title !== base.title) changes.title = pending.title;
    if (pending.document !== undefined && pending.document !== base.document) changes.document = pending.document;
    if (!Object.keys(changes).length) {
      if (pending.title === undefined || pending.title.trim()) { if (pending.document === undefined || pending.document === base.document) dropDraft(itemId); }
      return true;
    }
    setSaving((count) => count + 1);
    try {
      const saved = await updateItemMutation.mutateAsync({ item: { id: itemId, version: pending.baseVersion }, changes });
      const current = draftsRef.current[itemId];
      if (current) {
        const rest: Draft = { ...current, baseVersion: saved.version };
        if (rest.title === changes.title) delete rest.title;
        if (rest.document === changes.document) delete rest.document;
        if (rest.title === undefined && rest.document === undefined) dropDraft(itemId);
        else setDraftsBoth({ ...draftsRef.current, [itemId]: rest });
      }
      return true;
    } catch (cause) {
      if (isVersionConflict(cause)) conflicts.current.add(itemId);
      report('Could not save item', cause, 'item', () => reload(itemId));
      return false;
    } finally { setSaving((count) => count - 1); }
  }

  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;

  /** Saves the pending edits of an item now (or of all items when none is given). Saves run one after another. */
  const flush = useCallback((itemId?: string): Promise<boolean> => {
    const ids = itemId ? [itemId] : Object.keys(draftsRef.current);
    const run = queue.current.then(async () => {
      let ok = true;
      for (const id of ids) ok = (await saveRef.current(id)) && ok;
      return ok;
    });
    queue.current = run;
    return run;
  }, []);

  useEffect(() => () => { void flush(); }, [flush]);

  function editSelected(changes: { title?: string; document?: string }) {
    if (!selectedId || !serverItem) return;
    const id = selectedId;
    const existing = draftsRef.current[id];
    setDraftsBoth({ ...draftsRef.current, [id]: { ...existing, ...changes, baseVersion: existing?.baseVersion ?? serverItem.version } });
    window.clearTimeout(timers.current.get(id));
    timers.current.set(id, window.setTimeout(() => { void flush(id); }, autosaveDelayMs));
  }

  function selectItem(id: string) {
    if (id === selectedId) return;
    if (selectedId) void flush(selectedId);
    setError('');
    setPickedId(id);
    const selected = items.find((entry) => entry.id === id);
    if (selected) setNotice(`${itemTypeLabel[selected.type]} selected`);
  }

  async function createItem(type: ItemType, title: string, parentId?: string): Promise<boolean> {
    setError('');
    try {
      const created = await createItemMutation.mutateAsync({ type, title, parentId });
      setPickedId(created.id);
      setNotice(`${itemTypeLabel[created.type]} created`);
      return true;
    } catch (cause) { report('Could not create backlog item', cause, 'project'); return false; }
  }

  function startNewSession() {
    if (!selectedId) return;
    const created = newSession(selectedId);
    setSessionsByItem((current) => ({ ...current, [selectedId]: [created, ...(current[selectedId] ?? [])] }));
    setActiveSessionIds((current) => ({ ...current, [selectedId]: created.id }));
    setNotice('A new refinement session has started.');
  }

  function switchSession(sessionId: string): boolean {
    if (!selectedId || !sessions.some((entry) => entry.id === sessionId)) { setError('That refinement session no longer exists.'); return false; }
    setActiveSessionIds((current) => ({ ...current, [selectedId]: sessionId }));
    return true;
  }

  function deleteCurrentSession(): boolean {
    if (!selectedId || !session) return false;
    if (!window.confirm('Delete this refinement session and its conversation? The backlog item and accepted changes will remain.')) return false;
    const remaining = sessions.filter((entry) => entry.id !== session.id);
    const next = remaining.length ? remaining : [newSession(selectedId)];
    setSessionsByItem((current) => ({ ...current, [selectedId]: next }));
    setActiveSessionIds((current) => ({ ...current, [selectedId]: next[0].id }));
    setNotice('Refinement session deleted.');
    return true;
  }

  async function changeStatus(status: ItemStatus): Promise<boolean> {
    if (!selectedId) return false;
    if (!(await flush(selectedId))) return false;
    const base = latestItem(selectedId);
    if (!base) return false;
    try { await statusMutation.mutateAsync({ item: base, status }); return true; }
    catch (cause) { report('Could not change status', cause, 'item', () => reload(selectedId)); return false; }
  }

  async function restoreRevision(revisionId: string): Promise<boolean> {
    if (!selectedId) return false;
    if (!(await flush(selectedId))) return false;
    const base = latestItem(selectedId);
    if (!base) return false;
    try {
      await restoreMutation.mutateAsync({ item: base, revisionId });
      dropDraft(selectedId);
      setNotice('Restored the selected version.');
      return true;
    } catch (cause) { report('Could not restore version', cause, 'item', () => reload(selectedId)); return false; }
  }

  /** Server revisions are newest first and the newest is the current content, so "undo" restores the second one. */
  async function undoLastChange(): Promise<boolean> {
    const previous = revisions[1];
    if (!previous) { setNotice('There is no earlier version to restore.'); return false; }
    return restoreRevision(previous.id);
  }

  async function resolveChecklist(line: number, action: 'check' | 'remove', message: string) {
    if (!selectedItem) return;
    const document = updateChecklistLine(selectedItem.document, line, action);
    if (document === selectedItem.document) return;
    editSelected({ document });
    if (await flush(selectedItem.id)) setNotice(message);
  }

  async function duplicateSelected() {
    if (!selectedItem) return;
    try {
      if (!(await flush(selectedItem.id))) return;
      const copy = await createItemMutation.mutateAsync({ type: selectedItem.type, title: `${selectedItem.title} (copy)`, parentId: selectedItem.parentId ?? undefined });
      await updateItemMutation.mutateAsync({ item: copy, changes: { document: selectedItem.document } });
      setPickedId(copy.id);
      setNotice('Item duplicated.');
    } catch (cause) { report('Could not duplicate item', cause, 'item'); }
  }

  async function deleteSelected(): Promise<boolean> {
    if (!selectedItem || !window.confirm(`Delete “${selectedItem.title}” and its refinement sessions? Related items will be kept.`)) return false;
    try {
      const target = latestItem(selectedItem.id) ?? selectedItem;
      dropDraft(target.id);
      await deleteItemMutation.mutateAsync({ id: target.id, version: target.version });
      setPickedId(undefined);
      setNotice('Backlog item deleted. Related items were kept.');
      return true;
    } catch (cause) { report('Could not delete item', cause, 'item', () => reload()); return false; }
  }

  const loadError = itemsQuery.error ?? itemQuery.error;
  useEffect(() => { if (loadError) setError(`Could not load the backlog: ${errorText(loadError)}`); }, [loadError]);

  return {
    items, selectedId, selectedItem, serverItem, selectedSummary, parentItem, revisions, session, sessions,
    loading: itemsQuery.isLoading || (Boolean(selectedId) && itemQuery.isLoading), saving: saving > 0,
    selectItem, createItem, startNewSession, switchSession, deleteCurrentSession, editSelected, flush, changeStatus, restoreRevision, undoLastChange,
    resolveChecklist, duplicateSelected, deleteSelected, reload: () => reload(selectedId),
  };
}

export type Backlog = ReturnType<typeof useBacklog>;
