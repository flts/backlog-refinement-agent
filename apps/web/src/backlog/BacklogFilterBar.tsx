import { useEffect, useRef } from 'react';
import type { ItemStatus, ItemType } from '../api';
import { itemTypeLabel, statusText } from '../app/labels';
import { emptyFilter, filterStatuses, filterTypes, isFilterActive, type BacklogFilter } from './filterTree';

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export interface BacklogFilterBarProps {
  filter: BacklogFilter;
  onChange: (filter: BacklogFilter) => void;
  total: number;
  matchCount: number;
  needsInputCount: number;
}

/** Search box (`/` focuses it, Esc clears) and chips for type, status and "Needs input", with a polite result count. */
export function BacklogFilterBar({ filter, onChange, total, matchCount, needsInputCount }: BacklogFilterBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const active = isFilterActive(filter);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTextField(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const chip = (label: string, pressed: boolean, onClick: () => void, key = label) => (
    <button key={key} type="button" className={`filter-chip ${pressed ? 'active' : ''}`} aria-pressed={pressed} onClick={onClick}>{label}</button>
  );

  return (
    <div className="backlog-filter" role="search" aria-label="Filter backlog">
      <input
        ref={inputRef} type="search" className="filter-input" placeholder="Filter items  ( / )" aria-label="Filter backlog items by title" aria-keyshortcuts="/"
        value={filter.query} onChange={(event) => onChange({ ...filter, query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          if (filter.query) { event.preventDefault(); onChange({ ...filter, query: '' }); }
          else if (active) { event.preventDefault(); onChange(emptyFilter); }
        }}
      />
      <div className="filter-chips" role="group" aria-label="Filter by type">
        {filterTypes.map((type: ItemType) => chip(itemTypeLabel[type], filter.types.includes(type), () => onChange({ ...filter, types: toggle(filter.types, type) }), type))}
      </div>
      <div className="filter-chips" role="group" aria-label="Filter by status">
        {filterStatuses.map((status: ItemStatus) => chip(statusText(status), filter.statuses.includes(status), () => onChange({ ...filter, statuses: toggle(filter.statuses, status) }), status))}
      </div>
      <div className="filter-chips" role="group" aria-label="Filter by agent activity">
        {chip(needsInputCount > 0 ? `Needs input (${needsInputCount})` : 'Needs input', filter.needsInput, () => onChange({ ...filter, needsInput: !filter.needsInput }), 'needs-input')}
        {active && <button type="button" className="filter-clear" onClick={() => onChange(emptyFilter)}>Clear filters</button>}
      </div>
      <p className="filter-count" role="status" aria-live="polite">{active ? `${matchCount} of ${total} ${total === 1 ? 'item matches' : 'items match'}` : ''}</p>
    </div>
  );
}
