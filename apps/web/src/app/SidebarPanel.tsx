import React, { useState } from 'react';
import type { ItemSummary, ItemType } from '../api';
import { statusText, typeShort } from './labels';

type Props = {
  className: string;
  items: ItemSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: (parent?: { id: string; childType: ItemType }) => void;
};

export function SidebarPanel({ className, items, selectedId, onSelect, onCreate }: Props) {
  // The server lists items in creation order; the tree is built from each item's parentId.
  const ids = new Set(items.map((item) => item.id));
  const roots = items.filter((item) => !item.parentId || !ids.has(item.parentId));
  const addChild = (parentId: string) => {
    const parent = items.find((item) => item.id === parentId);
    onCreate({ id: parentId, childType: parent?.type === 'capability' ? 'feature' : parent?.type === 'feature' ? 'user-story' : 'enabler' });
  };
  return (
    <aside className={className}>
      <div className="sidebar-head"><div><span className="eyebrow">Workspace</span><h2>Backlog</h2></div><button className="add-button" aria-label="Create backlog item" onClick={() => onCreate()}><span aria-hidden="true">+</span></button></div>
      <div className="backlog-summary"><span>{items.length} {items.length === 1 ? 'item' : 'items'}</span><span className="summary-dot">·</span><span>{items.filter((item) => item.status === 'ready' || item.status === 'ready-with-open-questions').length} ready</span></div>
      <div className="tree-list">
        {roots.length ? roots.map((root) => <TreeItem key={root.id} item={root} allItems={items} selectedId={selectedId} onSelect={onSelect} onAddChild={addChild} />) : <div className="tree-empty"><span className="empty-icon">⌘</span><strong>Your backlog starts here</strong><p>Add a capability, feature, story, or enabler to begin shaping the work.</p><button className="button button-secondary button-small" onClick={() => onCreate()}>Create first item</button></div>}
      </div>
    </aside>
  );
}

function TreeItem({ item, allItems, selectedId, onSelect, onAddChild, depth = 0 }: {
  item: ItemSummary; allItems: ItemSummary[]; selectedId?: string;
  onSelect: (id: string) => void; onAddChild: (id: string) => void; depth?: number;
}) {
  const children = allItems.filter((candidate) => candidate.parentId === item.id);
  const [expanded, setExpanded] = useState(true);
  return <div className="tree-node"><div className={`tree-row ${selectedId === item.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 17 }}><button className="tree-expand" disabled={!children.length} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.title}`} onClick={() => setExpanded((value) => !value)}><span className={`tree-chevron ${children.length && expanded ? 'expanded' : ''}`}>{children.length ? '›' : ''}</span></button><button className="tree-select" onClick={() => onSelect(item.id)} aria-current={selectedId === item.id ? 'page' : undefined}><span className={`tree-type tree-type-${item.type}`}>{typeShort[item.type]}</span><span className="tree-title">{item.title}</span><span className={`tree-status tree-status-${item.status}`} aria-label={statusText(item.status)} /></button><button className="tree-add" aria-label={`Add child to ${item.title}`} onClick={() => onAddChild(item.id)}>+</button></div>{children.length > 0 && expanded && <div className="tree-children">{children.map((child) => <TreeItem key={child.id} item={child} allItems={allItems} selectedId={selectedId} onSelect={onSelect} onAddChild={onAddChild} depth={depth + 1} />)}</div>}</div>;
}
