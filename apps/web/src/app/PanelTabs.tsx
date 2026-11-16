import { useRef, type KeyboardEvent } from 'react';

export interface PanelTab<Id extends string = string> { id: Id; label: string; /** Shown as a small badge when above zero. */ count?: number }

export const tabButtonId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * WAI-ARIA tabs (automatic activation): Left/Right (wrapping), Home and End move focus and select; only the selected tab is in the tab order.
 * Render one element with `role="tabpanel"`, `id={tabPanelId(idPrefix, id)}` and `aria-labelledby={tabButtonId(idPrefix, id)}` per tab.
 */
export function PanelTabs<Id extends string>({ tabs, active, onChange, idPrefix, label }: { tabs: PanelTab<Id>[]; active: Id; onChange: (id: Id) => void; idPrefix: string; label: string }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
    if (target === undefined) return;
    event.preventDefault();
    onChange(tabs[target].id);
    buttons.current.get(tabs[target].id)?.focus();
  }

  return <div className="panel-tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" className="panel-tab" id={tabButtonId(idPrefix, tab.id)} aria-selected={tab.id === active} aria-label={tab.count ? `${tab.label} (${tab.count})` : undefined}
      aria-controls={tabPanelId(idPrefix, tab.id)} tabIndex={tab.id === active ? 0 : -1} ref={(node) => { if (node) buttons.current.set(tab.id, node); else buttons.current.delete(tab.id); }}
      onClick={() => onChange(tab.id)} onKeyDown={(event) => onKeyDown(event, index)}>
      {tab.label}{Boolean(tab.count) && <span className="panel-tab-count" aria-hidden="true">{tab.count}</span>}
    </button>)}
  </div>;
}
