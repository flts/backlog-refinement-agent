import { describe, expect, it } from 'vitest';
import type { ItemSummary } from '../api';
import { emptyFilter, filterTree } from './filterTree';

const item = (id: string, title: string, over: Partial<ItemSummary> = {}): ItemSummary => ({ id, parentId: null, type: 'feature', title, status: 'draft', version: 1, quality: null, updatedAt: '', updatedBy: '', ...over });
const items = [
  item('cap', 'Checkout', { type: 'capability' }),
  item('feat', 'Payments', { parentId: 'cap' }),
  item('story', 'Pay with iDEAL', { parentId: 'feat', type: 'user-story', status: 'ready' }),
  item('other', 'Reporting', { type: 'capability', status: 'refining' }),
  item('enab', 'Audit log', { type: 'enabler', parentId: 'other' }),
];
const none = new Set<string>();
const ids = (result: { items: ItemSummary[] }) => result.items.map((entry) => entry.id);

describe('filterTree', () => {
  it('returns everything without an active filter', () => {
    const result = filterTree(items, { ...emptyFilter, query: '  ' }, none);
    expect(result.active).toBe(false);
    expect(ids(result)).toEqual(['cap', 'feat', 'story', 'other', 'enab']);
  });

  it('matches titles case-insensitively and keeps the ancestors of matches', () => {
    const result = filterTree(items, { ...emptyFilter, query: 'IDEAL' }, none);
    expect(ids(result)).toEqual(['cap', 'feat', 'story']);
    expect([...result.matchIds]).toEqual(['story']);
    expect(result.matchCount).toBe(1);
  });

  it('filters by type and status chips (any value of a group, groups combined)', () => {
    expect(ids(filterTree(items, { ...emptyFilter, types: ['enabler', 'user-story'] }, none))).toEqual(['cap', 'feat', 'story', 'other', 'enab']);
    expect(filterTree(items, { ...emptyFilter, types: ['enabler', 'user-story'] }, none).matchCount).toBe(2);
    const both = filterTree(items, { ...emptyFilter, types: ['user-story'], statuses: ['draft'] }, none);
    expect(both.matchCount).toBe(0);
    expect(both.items).toEqual([]);
    expect(filterTree(items, { ...emptyFilter, statuses: ['refining', 'ready'] }, none).matchCount).toBe(2);
  });

  it('filters on items that need input', () => {
    const result = filterTree(items, { ...emptyFilter, needsInput: true }, new Set(['enab', 'unknown']));
    expect(ids(result)).toEqual(['other', 'enab']);
    expect(result.matchCount).toBe(1);
  });

  it('keeps an item whose parent is missing as a root', () => {
    expect(ids(filterTree([item('x', 'Orphan', { parentId: 'gone' })], { ...emptyFilter, query: 'orph' }, none))).toEqual(['x']);
  });
});
