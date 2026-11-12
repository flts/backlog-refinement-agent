import { useCallback, useEffect, useState } from 'react';
import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';
import type { BacklogRelationship } from '../domain/relationship';
import type { RefinementSession } from '../domain/refinement-session';
import { updateChecklistLine } from '../domain/document';
import { itemTypeLabel } from './labels';
import type { WorkspaceApplicationService } from '../application/workspace-service';
import { errorText, type Notifications } from './useNotifications';

export function useBacklog({ setError, setNotice }: Notifications, workspace: WorkspaceApplicationService) {
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [relationships, setRelationships] = useState<BacklogRelationship[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [session, setSession] = useState<RefinementSession>();
  const [sessions, setSessions] = useState<RefinementSession[]>([]);
  const [loading, setLoading] = useState(true);

  const selectedItem = items.find((item) => item.id === selectedId);
  const parentRelationship = selectedItem && relationships.find((relationship) => relationship.type === 'parent-child' && relationship.targetId === selectedItem.id);
  const parentItem = parentRelationship && items.find((item) => item.id === parentRelationship.sourceId);

  const refresh = useCallback(async (preferredId?: string) => {
    const [nextItems, nextRelationships] = await Promise.all([workspace.listItems(), workspace.listRelationships()]);
    setItems(nextItems);
    setRelationships(nextRelationships);
    const id = preferredId ?? selectedId;
    if (id && nextItems.some((item) => item.id === id)) setSelectedId(id);
    else if (nextItems[0]) setSelectedId(nextItems[0].id);
    else setSelectedId(undefined);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch((cause: unknown) => { if (!cancelled) setError(`Could not load local backlog: ${errorText(cause)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedId) { setSession(undefined); setSessions([]); return; }
    let cancelled = false;
    workspace.getOrCreateSession(selectedId)
      .then(async (next) => {
        const history = await workspace.listSessionsForItem(selectedId);
        if (!cancelled) { setSession(next); setSessions(history); }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(`Could not resume refinement: ${errorText(cause)}`); });
    return () => { cancelled = true; };
  }, [selectedId]);

  function selectItem(id: string) {
    setError(''); setSession(undefined); setSessions([]); setSelectedId(id);
    const selected = items.find((item) => item.id === id);
    if (selected) setNotice(`${itemTypeLabel[selected.type]} selected`);
  }

  async function createItem(type: BacklogItemType, title: string, parentId?: string): Promise<boolean> {
    setError('');
    try {
      const created = await workspace.createItem(type, title.trim() || undefined, parentId);
      await refresh(created.id);
      setNotice(`${itemTypeLabel[created.type]} created`);
      return true;
    } catch (cause) { setError(`Could not create backlog item: ${errorText(cause)}`); return false; }
  }

  async function startNewSession() {
    if (!selectedItem) return;
    try {
      const created = await workspace.createSession(selectedItem.id);
      setSession(created);
      setSessions((current) => [created, ...current]);
      setNotice('A new refinement session has started.');
    } catch (cause) { setError(`Could not start a session: ${errorText(cause)}`); }
  }

  async function switchSession(sessionId: string): Promise<boolean> {
    try {
      const next = await workspace.getSession(sessionId);
      if (!next) throw new Error('That refinement session no longer exists.');
      setSession(next);
      return true;
    } catch (cause) { setError(`Could not resume session: ${errorText(cause)}`); return false; }
  }

  async function deleteCurrentSession(): Promise<boolean> {
    if (!selectedItem || !session) return false;
    if (!window.confirm('Delete this refinement session and its conversation? The backlog item and accepted changes will remain.')) return false;
    try {
      await workspace.deleteSessionForItem(selectedItem.id, session.id);
      setSession(undefined);
      const remaining = await workspace.listSessionsForItem(selectedItem.id);
      setSessions(remaining);
      const next = remaining[0] ?? await workspace.createSession(selectedItem.id);
      setSessions(remaining.length ? remaining : [next]);
      setSession(next);
      setNotice('Refinement session deleted.');
      return true;
    } catch (cause) {
      setError(`Could not delete refinement session: ${errorText(cause)}`);
      return false;
    }
  }

  async function updateSelected(changes: Partial<BacklogItem>): Promise<boolean> {
    if (!selectedItem) return false;
    const optimistic = { ...selectedItem, ...changes, updatedAt: new Date().toISOString() };
    setItems((current) => current.map((item) => item.id === optimistic.id ? optimistic : item));
    try {
      const updated = await workspace.updateItem(optimistic);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      return true;
    } catch (cause) {
      setError(`Could not save item: ${errorText(cause)}`);
      const persisted = await workspace.getItem(selectedItem.id).catch(() => undefined);
      if (persisted) setItems((current) => current.map((item) => item.id === persisted.id ? persisted : item));
      return false;
    }
  }

  async function resolveChecklist(line: number, action: 'check' | 'remove', message: string) {
    if (!selectedItem) return;
    const description = updateChecklistLine(selectedItem.description, line, action);
    if (description === selectedItem.description) return;
    const saved = await updateSelected({ description });
    if (saved) setNotice(message);
  }

  async function duplicateSelected() {
    if (!selectedItem) return;
    try {
      const copy = await workspace.createItem(selectedItem.type, `${selectedItem.title} (copy)`, parentRelationship?.sourceId);
      await workspace.updateItem({ ...copy, description: selectedItem.description });
      await refresh(copy.id);
      setNotice('Item duplicated.');
    } catch (cause) { setError(`Could not duplicate item: ${errorText(cause)}`); }
  }

  async function deleteSelected(): Promise<boolean> {
    if (!selectedItem || !window.confirm(`Delete “${selectedItem.title}” and its refinement sessions? Related items will be kept.`)) return false;
    try {
      await workspace.deleteItemAndReferences(selectedItem.id);
      setSession(undefined);
      await refresh();
      setNotice('Backlog item deleted. Related items were kept.');
      return true;
    } catch (cause) { setError(`Could not delete item: ${errorText(cause)}`); return false; }
  }

  return {
    items, relationships, selectedId, selectedItem, parentItem, session, sessions, loading,
    workspace, setItems, setSession, refresh, selectItem, createItem, startNewSession, switchSession, deleteCurrentSession, updateSelected, resolveChecklist, duplicateSelected, deleteSelected,
  };
}

export type Backlog = ReturnType<typeof useBacklog>;
