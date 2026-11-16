import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { backlogKeys, isVersionConflict, useUpdateItem, type Item, type ItemChanges } from '../api';
import type { Notifications } from '../app/useNotifications';
import { applyMerge, planMerge, type MergeInput, type MergePlan } from './merge';

export const autosaveDelayMs = 1000;

export type SaveStatus = 'saved' | 'saving' | 'conflict' | 'error';

/**
 * Unsaved edits of one item. `baseVersion` is sent as `If-Match`; `baseTitle`/`baseDocument` are the content the user started
 * from, which a three-way merge needs when somebody else saved in between.
 */
export interface Draft { title?: string; document?: string; baseVersion: number; baseTitle: string; baseDocument: string }

export interface ConflictState {
  itemId: string;
  /** The server's current item (`ConflictError.item`). */
  theirs: Item;
  /** What the user started editing from, and what they wrote. */
  base: MergeInput;
  mine: MergeInput;
  plan: MergePlan;
}

type Base = Pick<Item, 'id' | 'version' | 'title' | 'document'>;
type Consumed = { title?: string; document?: string };

const isDirty = (draft: Draft) => (draft.title !== undefined && draft.title.trim() !== '' && draft.title !== draft.baseTitle)
  || (draft.document !== undefined && draft.document !== draft.baseDocument);

/**
 * Debounced (1 s) autosave queue per item. Saves run one after another with `If-Match` = the version the edit chain is based on.
 * A 409 is merged section by section against the server's item; only sections both sides changed differently open the conflict
 * dialog (`openConflict`, answered with `resolveConflict`), everything else is merged automatically.
 */
export function useItemAutosave(projectId: string, notifications: Pick<Notifications, 'setNotice' | 'report'>, nameOf: (email: string) => string = (email) => email) {
  const { setNotice, report } = notifications;
  const queryClient = useQueryClient();
  const updateItem = useUpdateItem(projectId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef<Record<string, Draft>>({});
  const timers = useRef(new Map<string, number>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState(false);
  const [conflicts, setConflicts] = useState<Record<string, ConflictState>>({});
  const conflictsRef = useRef<Record<string, ConflictState>>({});
  const [postponed, setPostponed] = useState<Record<string, boolean>>({});

  const setDraftsBoth = (next: Record<string, Draft>) => { draftsRef.current = next; setDrafts(next); };
  const setConflictsBoth = (next: Record<string, ConflictState>) => { conflictsRef.current = next; setConflicts(next); };
  const clearTimer = (itemId: string) => { window.clearTimeout(timers.current.get(itemId)); timers.current.delete(itemId); };

  const clearConflict = (itemId: string) => {
    const { [itemId]: _gone, ...rest } = conflictsRef.current;
    setConflictsBoth(rest);
    setPostponed(({ [itemId]: _hidden, ...others }) => others);
  };
  const dropDraft = useCallback((itemId: string) => {
    clearTimer(itemId);
    const { [itemId]: _removed, ...rest } = draftsRef.current;
    setDraftsBoth(rest);
    if (conflictsRef.current[itemId]) clearConflict(itemId);
  }, []);

  /** Throws away the unsaved edits of an item and refetches the project (the "Reload" action). */
  const reload = (itemId?: string) => {
    if (itemId) dropDraft(itemId);
    void queryClient.invalidateQueries({ queryKey: backlogKeys.project(projectId) });
  };

  /** After a save: forget what was saved, keep what was typed meanwhile, and rebase the draft on the saved item. */
  function settle(itemId: string, saved: Item, consumed: Consumed) {
    const current = draftsRef.current[itemId];
    if (current) {
      const rest: Draft = { ...current, baseVersion: saved.version, baseTitle: saved.title, baseDocument: saved.document };
      if (rest.title !== undefined && (rest.title === consumed.title || rest.title === saved.title)) delete rest.title;
      if (rest.document !== undefined && (rest.document === consumed.document || rest.document === saved.document)) delete rest.document;
      if (rest.title === undefined && rest.document === undefined) dropDraft(itemId);
      else setDraftsBoth({ ...draftsRef.current, [itemId]: rest });
    }
    if (conflictsRef.current[itemId]) clearConflict(itemId);
  }

  function markFailed(itemId: string, cause: unknown) {
    setFailed(true);
    report('Could not save item', cause, 'item', () => reload(itemId));
  }

  /** PATCH of the difference between `current` (what the server has at `version`) and `target`. */
  async function send(itemId: string, version: number, current: MergeInput, target: MergeInput): Promise<Item | undefined> {
    const changes: ItemChanges = {};
    if (target.title.trim() && target.title !== current.title) changes.title = target.title;
    if (target.document !== current.document) changes.document = target.document;
    if (!Object.keys(changes).length) return undefined;
    return updateItem.mutateAsync({ item: { id: itemId, version }, changes });
  }

  /** Merges `mine` (started from `base`) into the server's item `theirs`; asks only about sections both sides changed. */
  async function reconcile(itemId: string, base: MergeInput, mine: MergeInput, theirs: Item): Promise<boolean> {
    const plan = planMerge(base, mine, theirs);
    if (plan.needsChoice) {
      setConflictsBoth({ ...conflictsRef.current, [itemId]: { itemId, theirs, base, mine, plan } });
      setPostponed(({ [itemId]: _hidden, ...others }) => others);
      return false;
    }
    const saved = await commit(itemId, base, mine, applyMerge(plan), theirs);
    if (saved) setNotice(`Merged your changes with the changes by ${nameOf(theirs.updatedBy)}.`);
    return saved;
  }

  /** Saves a merged result on top of `theirs`; yet another conflict in the meantime starts another merge round. */
  async function commit(itemId: string, base: MergeInput, mine: MergeInput, merged: MergeInput, theirs: Item): Promise<boolean> {
    setSaving((count) => count + 1);
    try {
      const saved = (await send(itemId, theirs.version, theirs, merged)) ?? theirs;
      settle(itemId, saved, { title: mine.title, document: mine.document });
      return true;
    } catch (cause) {
      if (isVersionConflict(cause) && cause.item) return reconcile(itemId, theirs, merged, cause.item);
      markFailed(itemId, cause);
      return false;
    } finally { setSaving((count) => count - 1); }
  }

  async function saveDraft(itemId: string): Promise<boolean> {
    clearTimer(itemId);
    const pending = draftsRef.current[itemId];
    if (!pending) return true;
    if (conflictsRef.current[itemId]) return false;
    const base: MergeInput = { title: pending.baseTitle, document: pending.baseDocument };
    // A blank title is kept in the field until the user types one; it is never sent.
    const blankTitle = pending.title !== undefined && !pending.title.trim();
    const mine: MergeInput = { title: blankTitle ? pending.baseTitle : pending.title ?? pending.baseTitle, document: pending.document ?? pending.baseDocument };
    setSaving((count) => count + 1);
    setFailed(false);
    try {
      const saved = await send(itemId, pending.baseVersion, base, mine);
      if (!saved) { if (!blankTitle) dropDraft(itemId); return true; }
      settle(itemId, saved, { title: blankTitle ? undefined : mine.title, document: mine.document });
      return true;
    } catch (cause) {
      if (isVersionConflict(cause) && cause.item) return await reconcile(itemId, base, mine, cause.item);
      markFailed(itemId, cause);
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

  /** Records an edit of `item` (as the server last showed it) and schedules the save. */
  function edit(item: Base, changes: { title?: string; document?: string }) {
    const existing = draftsRef.current[item.id];
    const next: Draft = existing ? { ...existing, ...changes } : { ...changes, baseVersion: item.version, baseTitle: item.title, baseDocument: item.document };
    setDraftsBoth({ ...draftsRef.current, [item.id]: next });
    setFailed(false);
    clearTimer(item.id);
    if (conflictsRef.current[item.id]) return;
    timers.current.set(item.id, window.setTimeout(() => { void flush(item.id); }, autosaveDelayMs));
  }

  /** Saves the merged result chosen in the conflict dialog on top of the server's item. */
  async function resolveConflict(itemId: string, merged: MergeInput): Promise<boolean> {
    const state = conflictsRef.current[itemId];
    if (!state) return false;
    const saved = await commit(itemId, state.base, state.mine, merged, state.theirs);
    if (saved) setNotice('Conflict resolved and saved.');
    return saved;
  }

  const dirty = Object.values(drafts).some(isDirty);
  const status: SaveStatus = Object.keys(conflicts).length > 0 ? 'conflict' : saving > 0 || dirty ? 'saving' : failed ? 'error' : 'saved';

  return {
    drafts, edit, flush, dropDraft, reload, status, saving: saving > 0, conflicts, resolveConflict,
    /** The conflict of `itemId` waiting for a decision, unless the user postponed it. */
    openConflict: (itemId: string | undefined) => itemId && !postponed[itemId] ? conflicts[itemId] : undefined,
    postponeConflict: (itemId: string) => setPostponed((current) => ({ ...current, [itemId]: true })),
    reopenConflict: (itemId: string) => setPostponed(({ [itemId]: _hidden, ...others }) => others),
  };
}

export type ItemAutosave = ReturnType<typeof useItemAutosave>;
