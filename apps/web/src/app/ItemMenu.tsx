import React, { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuAction { id: string; label: ReactNode; danger?: boolean; onSelect: () => void }

export function ItemMenu({ actions }: { actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    const items = [...(wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
  }

  return (
    <div className="menu-wrap" ref={wrapRef} onKeyDown={onKeyDown}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={buttonRef} type="button" className="more-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>···</button>
      {open && <div className="menu-popover" role="menu">
        {actions.map((action) => (
          <button key={action.id} type="button" role="menuitem" className={`menu-item ${action.danger ? 'menu-danger' : ''}`}
            onClick={() => { close(true); action.onSelect(); }}>{action.label}</button>
        ))}
      </div>}
    </div>
  );
}
