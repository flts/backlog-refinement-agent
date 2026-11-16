import type { ItemStatus, ItemSummary, ItemType } from '../api';

export interface BacklogFilter {
  /** Case-insensitive substring of the item title. */
  query: string;
  /** Item types to show; empty means all. */
  types: ItemType[];
  /** Item statuses to show; empty means all. */
  statuses: ItemStatus[];
  /** Only items where one of the user's own agent threads is waiting for them. */
  needsInput: boolean;
}

export const emptyFilter: BacklogFilter = { query: '', types: [], statuses: [], needsInput: false };

export const filterTypes: readonly ItemType[] = ['capability', 'feature', 'user-story', 'enabler'];
export const filterStatuses: readonly ItemStatus[] = ['draft', 'refining', 'ready', 'ready-with-open-questions', 'complete'];

export function isFilterActive(filter: BacklogFilter): boolean {
  return filter.query.trim() !== '' || filter.types.length > 0 || filter.statuses.length > 0 || filter.needsInput;
}

export interface FilteredTree {
  /** Matches plus their ancestors, in the original order. */
  items: ItemSummary[];
  /** Items that match the filter themselves (the others are only kept as context). */
  matchIds: ReadonlySet<string>;
  matchCount: number;
  active: boolean;
}

/**
 * Filters the backlog. Criteria combine with AND (a chip group matches any of its values); the ancestors of every match
 * stay in the result so the hierarchy remains visible. `needsInput` holds the ids of items whose own thread awaits input or review.
 */
export function filterTree(items: readonly ItemSummary[], filter: BacklogFilter, needsInput: ReadonlySet<string>): FilteredTree {
  if (!isFilterActive(filter)) return { items: [...items], matchIds: new Set(items.map((item) => item.id)), matchCount: items.length, active: false };
  const query = filter.query.trim().toLowerCase();
  const matchIds = new Set<string>();
  for (const item of items) {
    if (query && !item.title.toLowerCase().includes(query)) continue;
    if (filter.types.length > 0 && !filter.types.includes(item.type)) continue;
    if (filter.statuses.length > 0 && !filter.statuses.includes(item.status)) continue;
    if (filter.needsInput && !needsInput.has(item.id)) continue;
    matchIds.add(item.id);
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const keep = new Set(matchIds);
  for (const id of matchIds) {
    for (let parent = byId.get(id)?.parentId; parent && byId.has(parent) && !keep.has(parent); parent = byId.get(parent)?.parentId) keep.add(parent);
  }
  return { items: items.filter((item) => keep.has(item.id)), matchIds, matchCount: matchIds.size, active: true };
}
