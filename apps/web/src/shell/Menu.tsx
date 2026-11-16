import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type MenuEntry =
  | { id: string; label: ReactNode; onSelect: () => void; checked?: boolean; danger?: boolean; disabled?: boolean }
  | { id: string; separator: true };

export interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  items: MenuEntry[];
  className?: string;
  triggerClassName?: string;
  align?: 'start' | 'end';
  disabled?: boolean;
}

const itemSelector = '[role^="menuitem"]:not([aria-disabled="true"])';

/**
 * WAI-ARIA menu button. Entries with `checked` are `menuitemradio`s. Arrow keys, Home/End and Escape work; Tab and clicking
 * elsewhere close the menu. Selecting an entry returns focus to the trigger first, so dialogs opened by an entry restore focus there.
 */
export function Menu({ label, trigger, items, className = '', triggerClassName = 'topbar-button', align = 'start', disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const entries = [...(wrap.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])];
    (entries.find((entry) => entry.getAttribute('aria-checked') === 'true') ?? entries[0])?.focus();
  }, [open]);

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    const entries = [...(wrap.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])];
    if (!entries.length) return;
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const move = (target: number) => { event.preventDefault(); entries[(target + entries.length) % entries.length].focus(); };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index < 0 ? -1 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
  }

  return <div className={`menu-wrap shell-menu ${className}`} ref={wrap} onKeyDown={onKeyDown}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={button} type="button" className={triggerClassName} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}>{trigger}</button>
    {open && <div id={menuId} className={`menu-popover shell-menu-popover align-${align}`} role="menu" aria-label={label} onMouseDown={(event) => event.preventDefault()}>
      {items.map((entry) => 'separator' in entry
        ? <div key={entry.id} role="separator" className="menu-separator" />
        : <button key={entry.id} type="button" role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={entry.checked}
          aria-disabled={entry.disabled || undefined} tabIndex={-1} className={`menu-item ${entry.danger ? 'menu-danger' : ''}`}
          onClick={() => { if (entry.disabled) return; close(true); entry.onSelect(); }}>{entry.label}</button>)}
    </div>}
  </div>;
}
