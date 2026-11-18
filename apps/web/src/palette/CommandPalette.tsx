import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useItems, useProjectSearch, type ItemType } from '../api';
import { itemTypeLabel, typeShort } from '../app/labels';
import { getThemePreference, setThemePreference } from '../app/theme';
import { useModalDialog } from '../app/useModalDialog';
import type { AgentIntent } from '../contracts';
import { agentCommandsFor, runAgentCommand } from './commands';
import { emitPaletteEvent, PALETTE_EVENTS, usePaletteEvent, type PaletteEventName } from './events';

export interface CommandPaletteProps {
  projectId: string;
  /** The item being refined; agent commands are only offered while there is one. */
  currentItem?: { id: string; type: ItemType };
  /** An agent run is in progress: agent commands are shown but disabled. */
  agentBusy?: boolean;
  onSelectItem: (id: string) => void;
  onRunIntent: (intent: AgentIntent, childType?: ItemType) => void;
  onNewSession: () => void;
  /** Optional callbacks for the actions of other components; without them the matching `palette:*` window event is dispatched. */
  onNewItem?: () => void;
  onOpenSources?: () => void;
  onOpenSettings?: () => void;
  onShare?: () => void;
  /** Delay before the semantic search runs after typing. */
  debounceMs?: number;
}

type Row = {
  id: string;
  group: 'items' | 'agent' | 'actions';
  label: string;
  badge?: string;
  description?: string;
  disabled?: boolean;
  run: () => void;
};

const GROUPS: { id: Row['group']; label: string }[] = [
  { id: 'items', label: 'Items' }, { id: 'agent', label: 'Agent commands' }, { id: 'actions', label: 'Actions' },
];
const MAX_ITEM_ROWS = 6;
const MAX_SEMANTIC_ROWS = 4;

function toggleTheme() {
  const preference = getThemePreference();
  const dark = preference === 'dark' || (preference === 'system' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  setThemePreference(dark ? 'light' : 'dark');
}

const matches = (text: string, needle: string) => !needle || text.toLowerCase().includes(needle);

/** ⌘K / Ctrl+K command palette: items (title match plus semantic search), agent commands and actions. */
export function CommandPalette(props: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  usePaletteEvent(PALETTE_EVENTS.open, () => setOpen(true));
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return open ? <PaletteDialog {...props} onClose={() => setOpen(false)} /> : null;
}

function PaletteDialog({ projectId, currentItem, agentBusy = false, onSelectItem, onRunIntent, onNewSession, onNewItem, onOpenSources, onOpenSettings, onShare, debounceMs = 250, onClose }: CommandPaletteProps & { onClose: () => void }) {
  const dialog = useModalDialog(onClose);
  const base = useId();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeId, setActiveId] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), debounceMs);
    return () => window.clearTimeout(timer);
  }, [query, debounceMs]);

  const itemsQuery = useItems(projectId);
  const search = useProjectSearch(projectId, debounced, 'items', { limit: 8 });
  const searchPending = debounced.length > 0 && search.isFetching;

  const rows = useMemo(() => {
    const result: Row[] = [];
    const close = (action: () => void) => () => { onClose(); action(); };
    const items = itemsQuery.data ?? [];
    const local = items.filter((item) => matches(item.title, needle)).slice(0, MAX_ITEM_ROWS);
    for (const item of local) {
      result.push({ id: `item:${item.id}`, group: 'items', label: item.title || 'Untitled item', badge: typeShort[item.type], run: close(() => onSelectItem(item.id)) });
    }
    if (needle && search.data && debounced.toLowerCase() === needle) {
      const seen = new Set(local.map((item) => item.id));
      const indicator = search.data.semantic ? 'semantic' : 'text match';
      for (const hit of (search.data.items ?? []).filter((entry) => !seen.has(entry.itemId)).slice(0, MAX_SEMANTIC_ROWS)) {
        const known = items.find((item) => item.id === hit.itemId);
        result.push({
          id: `hit:${hit.itemId}`, group: 'items', label: known?.title ?? hit.title, badge: indicator,
          description: hit.snippet ?? (itemTypeLabel[(known?.type ?? hit.type) as ItemType] ?? hit.type), run: close(() => onSelectItem(hit.itemId)),
        });
      }
    }
    if (currentItem) {
      for (const command of agentCommandsFor(currentItem.type)) {
        if (!matches(`${command.label} ${command.description} agent ${command.slash ?? ''}`, needle)) continue;
        result.push({
          id: `agent:${command.key}`, group: 'agent', label: command.label, badge: command.slash ? `/${command.slash}` : undefined,
          description: agentBusy ? 'The agent is working' : command.description, disabled: agentBusy,
          run: close(() => runAgentCommand(command, { onRunIntent, onNewSession })),
        });
      }
    }
    const via = (name: PaletteEventName, callback?: () => void) => close(() => (callback ? callback() : emitPaletteEvent(name)));
    const actions: Omit<Row, 'group'>[] = [
      { id: 'action:new-item', label: 'New item', description: 'Create a backlog item', run: via(PALETTE_EVENTS.newItem, onNewItem) },
      { id: 'action:sources', label: 'Open sources', description: 'Documents and links the agent can use', run: via(PALETTE_EVENTS.openSources, onOpenSources) },
      { id: 'action:settings', label: 'Project settings', description: 'Guidance, templates and members', run: via(PALETTE_EVENTS.openSettings, onOpenSettings) },
      { id: 'action:share', label: 'Share', description: 'Invite people to this project', run: via(PALETTE_EVENTS.share, onShare) },
      { id: 'action:theme', label: 'Toggle theme', description: 'Switch between light and dark', run: close(toggleTheme) },
    ];
    for (const action of actions) if (matches(`${action.label} ${action.description}`, needle)) result.push({ ...action, group: 'actions' });
    return result;
  }, [itemsQuery.data, search.data, debounced, needle, currentItem, agentBusy, onClose, onSelectItem, onRunIntent, onNewSession, onNewItem, onOpenSources, onOpenSettings, onShare]);

  const active = rows.find((row) => row.id === activeId) ?? rows[0];
  const optionId = (row: Row) => `${base}-${row.id.replace(/[^a-z0-9-]/gi, '_')}`;

  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  });

  function move(delta: number | 'first' | 'last') {
    if (rows.length === 0) return;
    const index = Math.max(0, rows.indexOf(active!));
    const next = delta === 'first' ? 0 : delta === 'last' ? rows.length - 1 : (index + delta + rows.length) % rows.length;
    setActiveId(rows[next].id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home' && !query) { event.preventDefault(); move('first'); }
    else if (event.key === 'End' && !query) { event.preventDefault(); move('last'); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (active && !active.disabled) active.run();
    }
  }

  const status = rows.length === 0 ? (searchPending ? 'Searching…' : 'No results') : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}${searchPending ? ', searching for more' : ''}`;
  const listId = `${base}-list`;

  return (
    <dialog className="modal-dialog palette-dialog" aria-label="Command palette" ref={dialog.ref} onCancel={dialog.onCancel} onKeyDown={dialog.onKeyDown} onMouseDown={dialog.onMouseDown}>
      <div className="palette">
        <div className="palette-search">
          <span aria-hidden="true">⌕</span>
          <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={active ? optionId(active) : undefined}
            aria-label="Search items, run agent commands or actions" placeholder="Search items, run a command…" autoComplete="off" spellCheck={false}
            value={query} onChange={(event) => { setQuery(event.target.value); setActiveId(undefined); }} onKeyDown={onKeyDown} />
          <kbd aria-hidden="true">Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} tabIndex={0} aria-label="Scrollable results">
          <div id={listId} role="listbox" aria-label="Results">
            {GROUPS.map((group) => {
              const groupRows = rows.filter((row) => row.group === group.id);
              if (groupRows.length === 0) return null;
              const headingId = `${base}-${group.id}`;
              return (
                <div key={group.id} role="group" aria-labelledby={headingId}>
                  <div className="palette-group" id={headingId} role="presentation">{group.label}</div>
                  {groupRows.map((row) => (
                    <div key={row.id} id={optionId(row)} role="option" className="palette-option" aria-selected={row === active} aria-disabled={row.disabled || undefined}
                      onMouseDown={(event) => event.preventDefault()} onMouseMove={() => active !== row && setActiveId(row.id)} onClick={() => !row.disabled && row.run()}>
                      <span className="palette-option-label">{row.label}</span>
                      {row.badge && <span className="palette-badge">{row.badge}</span>}
                      {row.description && <span className="palette-option-desc">{row.description}</span>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {rows.length === 0 && <p className="palette-empty" aria-hidden="true">{searchPending ? 'Searching…' : 'No results'}</p>}
        </div>
        <p className="sr-only" role="status">{status}</p>
        <p className="palette-footer" aria-hidden="true"><span>↑↓ navigate</span><span>↵ select</span><span>Esc close</span></p>
      </div>
    </dialog>
  );
}
