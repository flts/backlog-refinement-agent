import { useCallback, useState } from 'react';
import type { ItemStatus, ItemType } from '../api';
import { emptyFilter, filterStatuses, filterTypes, type BacklogFilter } from './filterTree';

export const filterStorageKey = (projectId: string) => `backlog-filter:${projectId}`;

function pick<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  return Array.isArray(value) ? allowed.filter((entry) => value.includes(entry)) : [];
}

export function loadFilter(projectId: string | undefined): BacklogFilter {
  if (!projectId) return emptyFilter;
  try {
    const raw = JSON.parse(sessionStorage.getItem(filterStorageKey(projectId)) ?? 'null') as Partial<Record<keyof BacklogFilter, unknown>> | null;
    if (!raw || typeof raw !== 'object') return emptyFilter;
    return {
      query: typeof raw.query === 'string' ? raw.query : '',
      types: pick<ItemType>(raw.types, filterTypes),
      statuses: pick<ItemStatus>(raw.statuses, filterStatuses),
      needsInput: raw.needsInput === true,
    };
  } catch {
    return emptyFilter;
  }
}

function saveFilter(projectId: string | undefined, filter: BacklogFilter) {
  if (!projectId) return;
  try {
    if (filter === emptyFilter || (filter.query === '' && !filter.types.length && !filter.statuses.length && !filter.needsInput)) sessionStorage.removeItem(filterStorageKey(projectId));
    else sessionStorage.setItem(filterStorageKey(projectId), JSON.stringify(filter));
  } catch { /* storage unavailable: the filter just isn't remembered */ }
}

/** The sidebar filter of one project, kept in sessionStorage (per project, per browser tab). */
export function useBacklogFilter(projectId: string | undefined) {
  const [state, setState] = useState(() => ({ projectId, filter: loadFilter(projectId) }));
  let current = state;
  if (state.projectId !== projectId) {
    current = { projectId, filter: loadFilter(projectId) };
    setState(current);
  }
  const setFilter = useCallback((next: BacklogFilter) => {
    saveFilter(projectId, next);
    setState({ projectId, filter: next });
  }, [projectId]);
  return [current.filter, setFilter] as const;
}
