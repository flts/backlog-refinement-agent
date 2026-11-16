import React, { useState } from 'react';
import type { ItemSummary, ItemType } from '../api';
import type { ThreadStatus } from '../agent';
import { BacklogFilterBar, ThreadStatusBadge, emptyFilter, filterTree, needsYouStatuses, useBacklogFilter } from '../backlog';
import { PresenceDot, type PresenceUser } from '../collab';
import { statusText, typeShort } from './labels';

type Props = {
  className: string;
  items: ItemSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: (parent?: { id: string; childType: ItemType }) => void;
  /** Other people who have an item open (presence dots in the tree). */
  presenceFor?: (itemId: string) => PresenceUser[];
  /** Project the filter is remembered for (sessionStorage). */
  projectId?: string;
  /** Status of the current user's own agent threads per item (`useProjectThreadStatuses`). */
  threadStatuses?: ReadonlyMap<string, ThreadStatus>;
};

const noStatuses: ReadonlyMap<string, ThreadStatus> = new Map();

type TreeContext = {
  allItems: ItemSummary[]; selectedId?: string; matchIds: ReadonlySet<string>; filtering: boolean;
  threadStatuses: ReadonlyMap<string, ThreadStatus>; presenceFor?: (itemId: string) => PresenceUser[];
  onSelect: (id: string) => void; onAddChild: (id: string) => void;
};

export function SidebarPanel({ className, items: allBacklogItems, selectedId, onSelect, onCreate, presenceFor, projectId, threadStatuses = noStatuses }: Props) {
  // The server lists items in creation order; the tree is built from each item's parentId.
  const [filter, setFilter] = useBacklogFilter(projectId);
  const needsInput = new Set([...threadStatuses].filter(([, status]) => needsYouStatuses.has(status)).map(([itemId]) => itemId));
  const filtered = filterTree(allBacklogItems, filter, needsInput);
  const items = filtered.items;
  const ids = new Set(items.map((item) => item.id));
  const roots = items.filter((item) => !item.parentId || !ids.has(item.parentId));
  const addChild = (parentId: string) => {
    const parent = allBacklogItems.find((item) => item.id === parentId);
    onCreate({ id: parentId, childType: parent?.type === 'capability' ? 'feature' : parent?.type === 'feature' ? 'user-story' : 'enabler' });
  };
  const ctx: TreeContext = { allItems: items, selectedId, matchIds: filtered.matchIds, filtering: filtered.active, threadStatuses, presenceFor, onSelect, onAddChild: addChild };
  return (
    <aside className={className}>
      <div className="sidebar-head"><div><span className="eyebrow">Workspace</span><h2>Backlog</h2></div><button className="add-button" aria-label="Create backlog item" onClick={() => onCreate()}><span aria-hidden="true">+</span></button></div>
      <div className="backlog-summary"><span>{allBacklogItems.length} {allBacklogItems.length === 1 ? 'item' : 'items'}</span><span className="summary-dot">·</span><span>{allBacklogItems.filter((item) => item.status === 'ready' || item.status === 'ready-with-open-questions').length} ready</span></div>
      {allBacklogItems.length > 0 && <BacklogFilterBar filter={filter} onChange={setFilter} total={allBacklogItems.length} matchCount={filtered.matchCount} needsInputCount={allBacklogItems.filter((item) => needsInput.has(item.id)).length} />}
      <div className="tree-list">
        {roots.length ? roots.map((root) => <TreeItem key={root.id} item={root} ctx={ctx} />) : filtered.active ? <div className="tree-empty"><strong>No items match</strong><p>Try a different search or remove a filter.</p><button className="button button-secondary button-small" onClick={() => setFilter(emptyFilter)}>Clear filters</button></div> : <div className="tree-empty"><span className="empty-icon">⌘</span><strong>Your backlog starts here</strong><p>Add a capability, feature, story, or enabler to begin shaping the work.</p><button className="button button-secondary button-small" onClick={() => onCreate()}>Create first item</button></div>}
      </div>
    </aside>
  );
}

function TreeItem({ item, ctx, depth = 0 }: { item: ItemSummary; ctx: TreeContext; depth?: number }) {
  const { allItems, selectedId, matchIds, filtering, threadStatuses, presenceFor, onSelect, onAddChild } = ctx;
  const children = allItems.filter((candidate) => candidate.parentId === item.id);
  const [collapsed, setCollapsed] = useState(false);
  // While filtering, every branch stays open so that no match is hidden.
  const expanded = filtering || !collapsed;
  const context = filtering && !matchIds.has(item.id);
  const status = threadStatuses.get(item.id);
  return <div className="tree-node"><div className={`tree-row ${selectedId === item.id ? 'selected' : ''} ${context ? 'tree-row-context' : ''}`} style={{ paddingLeft: 8 + depth * 17 }}><button className="tree-expand" disabled={!children.length || filtering} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.title}`} onClick={() => setCollapsed((value) => !value)}><span className={`tree-chevron ${children.length && expanded ? 'expanded' : ''}`}>{children.length ? '›' : ''}</span></button><button className="tree-select" onClick={() => onSelect(item.id)} aria-current={selectedId === item.id ? 'page' : undefined}><span className={`tree-type tree-type-${item.type}`}>{typeShort[item.type]}</span><span className="tree-title">{item.title}</span><span className={`tree-status tree-status-${item.status}`} aria-label={statusText(item.status)} /></button><ThreadStatusBadge status={status} /><PresenceDot people={presenceFor?.(item.id) ?? []} /><button className="tree-add" aria-label={`Add child to ${item.title}`} onClick={() => onAddChild(item.id)}>+</button></div>{children.length > 0 && expanded && <div className="tree-children">{children.map((child) => <TreeItem key={child.id} item={child} ctx={ctx} depth={depth + 1} />)}</div>}</div>;
}
