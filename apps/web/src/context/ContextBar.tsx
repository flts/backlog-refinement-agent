import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useGuidance, useItems, useRelationships, useSources, type ItemType, type Relationship } from '../api';
import { itemTypeLabel, typeShort } from '../app/labels';
import { emitPaletteEvent, PALETTE_EVENTS } from '../palette/events';

export interface ContextBarProps {
  projectId: string;
  item: { id: string; type: ItemType; title: string };
  /** Selects another item (parent or a related item). */
  onSelectItem: (id: string) => void;
}

const relationLabels: Record<Relationship['type'], { outgoing: string; incoming: string }> = {
  'parent-child': { outgoing: 'Child', incoming: 'Parent' },
  supports: { outgoing: 'Supports', incoming: 'Supported by' },
  'depends-on': { outgoing: 'Depends on', incoming: 'Required by' },
  'related-to': { outgoing: 'Related', incoming: 'Related' },
};

/** A focusable chip with a tooltip that is shown on hover and focus, stays while hovered and closes with Esc (WCAG 1.4.13). */
function Chip({ label, tooltip, children, className = '' }: { label?: string; tooltip: string; children: ReactNode; className?: string }) {
  const tipId = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span className={`context-chip ${className}`} tabIndex={0} aria-describedby={tipId} aria-label={label}
      onKeyDown={(event) => { if (event.key === 'Escape') setDismissed(true); }} onBlur={() => setDismissed(false)} onMouseLeave={() => setDismissed(false)}>
      {children}
      <span className="context-tooltip" role="tooltip" id={tipId} data-dismissed={dismissed || undefined}>{tooltip}</span>
    </span>
  );
}

/** The context the agent works with for the current item: the item, its parent, related items, sources and the template. */
export function ContextBar({ projectId, item, onSelectItem }: ContextBarProps) {
  const items = useItems(projectId).data ?? [];
  const relationships = useRelationships(projectId).data ?? [];
  const sources = useSources(projectId).data;
  const guidance = useGuidance(projectId).data;

  const summaryOf = (id: string) => items.find((entry) => entry.id === id);
  const parentLink = relationships.find((rel) => rel.type === 'parent-child' && rel.targetId === item.id);
  const parent = parentLink ? summaryOf(parentLink.sourceId) : undefined;
  const related = relationships
    .filter((rel) => (rel.sourceId === item.id || rel.targetId === item.id) && rel !== parentLink)
    .map((rel) => {
      const outgoing = rel.sourceId === item.id;
      const other = summaryOf(outgoing ? rel.targetId : rel.sourceId);
      return other && { id: rel.id, other, relation: relationLabels[rel.type][outgoing ? 'outgoing' : 'incoming'] };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const pinned = sources?.items.filter((source) => source.mode === 'pinned').length ?? 0;
  const searchable = sources?.items.filter((source) => source.mode === 'searchable').length ?? 0;
  const budget = sources?.pinnedBudget;
  const percent = budget && budget.limit > 0 ? Math.min(100, Math.round((budget.used / budget.limit) * 100)) : 0;
  const template = guidance?.templates[item.type];
  const templateText = template ? (template.source === 'project' ? 'Project template' : `Default template v${template.defaultVersion}`) : undefined;

  return (
    <div className="context-bar" role="group" aria-label="Context the agent uses">
      <Chip tooltip={`The item the agent is refining: ${itemTypeLabel[item.type]}`} label={`Current item: ${itemTypeLabel[item.type]} ${item.title || 'Untitled item'}`}>
        <span className="type-icon tiny" aria-hidden="true">{typeShort[item.type]}</span>
        <span className="context-chip-text">{item.title || 'Untitled item'}</span>
      </Chip>
      {parent && (
        <button type="button" className="context-chip context-chip-button" aria-label={`Parent: ${parent.title || 'Untitled item'}. Open`} onClick={() => onSelectItem(parent.id)}>
          <span aria-hidden="true">↑</span><span className="context-chip-text">{parent.title || 'Untitled item'}</span>
        </button>
      )}
      <RelatedChip related={related} onSelectItem={onSelectItem} />
      {sources && (
        <Chip tooltip="Pinned sources are always sent to the agent; searchable sources are searched on demand. Manage them under Sources."
          label={`Sources: ${pinned} pinned, ${searchable} searchable${budget ? `, ${budget.used.toLocaleString()} of ${budget.limit.toLocaleString()} characters pinned` : ''}`}>
          <span aria-hidden="true">▤</span>
          <span className="context-chip-text">{pinned} pinned · {searchable} searchable</span>
          {budget && <span className="context-meter" role="meter" aria-label="Pinned budget" aria-valuemin={0} aria-valuemax={budget.limit} aria-valuenow={Math.min(budget.used, budget.limit)} aria-valuetext={`${percent}% of the pinned budget used`} data-level={percent >= 100 ? 'full' : percent >= 90 ? 'near' : 'ok'}>
            <span style={{ width: `${percent}%` }} />
          </span>}
        </Chip>
      )}
      {templateText && (
        <Chip tooltip={template?.source === 'project' ? 'This project customised the template for this item type.' : 'The built-in template for this item type is used.'} label={`Template: ${templateText}`}>
          <span aria-hidden="true">▦</span><span className="context-chip-text">{templateText}</span>
        </Chip>
      )}
      <button type="button" className="context-chip context-chip-button context-sources-link" onClick={() => emitPaletteEvent(PALETTE_EVENTS.openSources)}>Manage sources</button>
    </div>
  );
}

function RelatedChip({ related, onSelectItem }: { related: { id: string; other: { id: string; title: string; type: ItemType }; relation: string }[]; onSelectItem: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const label = `${related.length} related ${related.length === 1 ? 'item' : 'items'}`;
  if (related.length === 0) return <span className="context-chip context-chip-muted" tabIndex={0} role="group" aria-label="No related items"><span aria-hidden="true">⇄</span> 0 related</span>;
  return (
    <span className="context-popover-root" ref={root} onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <button type="button" ref={trigger} className="context-chip context-chip-button" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={label} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">⇄</span><span className="context-chip-text">{related.length} related</span>
      </button>
      {open && (
        <div className="context-popover" id={panelId} role="group" aria-label="Related items">
          <ul>
            {related.map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => { setOpen(false); onSelectItem(entry.other.id); }}>
                  <span className="type-icon tiny" aria-hidden="true">{typeShort[entry.other.type]}</span>
                  <span className="context-popover-title">{entry.other.title || 'Untitled item'}</span>
                  <span className="context-popover-relation">{entry.relation}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
