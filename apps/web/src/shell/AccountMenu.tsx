import { useId, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { initialsOf } from '../collab';

/** Avatar button with a disclosure panel: name, email and Sign out (only when the SPA owns the session). */
export function AccountMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  return <div className="menu-wrap account-menu" ref={wrap}
    onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); button.current?.focus(); } }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={button} type="button" className="avatar-button" aria-label={`Account: ${auth.user.name}`} aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-haspopup="dialog" title={auth.user.email} onClick={() => setOpen((value) => !value)}>
      <span className="avatar" aria-hidden="true" data-initials={initialsOf(auth.user)} />
    </button>
    {open && <div id={panelId} className="menu-popover shell-menu-popover align-end account-panel" role="dialog" aria-label="Account" onMouseDown={(event) => event.preventDefault()}>
      <p className="account-name">{auth.user.name}</p>
      <p className="account-email">{auth.user.email}</p>
      {auth.canSignOut
        ? <button type="button" className="button button-secondary button-small" disabled={signingOut}
          onClick={() => { setSigningOut(true); auth.signOut().catch(() => setSigningOut(false)); }}>Sign out</button>
        : <p className="settings-help">Your session is managed by your organisation&apos;s sign-in.</p>}
    </div>}
  </div>;
}
