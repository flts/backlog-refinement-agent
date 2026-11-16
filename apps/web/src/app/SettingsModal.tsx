import { useState } from 'react';
import { useAuth } from '../auth';
import { getThemePreference, setThemePreference, type ThemePreference } from './theme';
import { useModalDialog } from './useModalDialog';

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * User settings (Account, Appearance) plus a gateway to the project settings (`onOpenProjectSettings`, omitted when there is no current project).
 * Project guidance (instructions, templates) is edited per project by its owners in the project settings.
 */
export function SettingsModal({ onClose, projectName, onOpenProjectSettings }: { onClose: () => void; projectName?: string; onOpenProjectSettings?: () => void }) {
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const dialog = useModalDialog(onClose);
  const auth = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <dialog className="modal-dialog" aria-labelledby="settings-title" {...dialog}>
      <div className="modal settings-modal">
        <button type="button" className="close-button modal-close" onClick={onClose} aria-label="Close settings"><span aria-hidden="true">×</span></button>
        <span className="eyebrow">Your preferences</span><h2 id="settings-title">Settings</h2>
        <div className="settings-body">
          <fieldset className="account-section" aria-describedby="account-help">
            <legend>Account</legend>
            <dl className="account-details">
              <div><dt>Name</dt><dd>{auth.user.name}</dd></div>
              <div><dt>Email</dt><dd>{auth.user.email}</dd></div>
            </dl>
            {auth.canSignOut
              ? <>
                <p className="settings-help" id="account-help">Signing out ends your session with the identity provider.</p>
                <button type="button" className="button button-secondary button-small" disabled={signingOut}
                  onClick={() => { setSigningOut(true); auth.signOut().catch(() => setSigningOut(false)); }}>Sign out</button>
              </>
              : <p className="settings-help" id="account-help">Your session is managed by your organisation&apos;s sign-in; close the browser window or use your organisation&apos;s sign-out to end it.</p>}
          </fieldset>
          <fieldset className="theme-choice" aria-describedby="theme-help">
            <legend>Appearance</legend>
            <p className="settings-help" id="theme-help">Applies immediately and is stored in this browser only. System follows your operating system&apos;s light or dark setting.</p>
            <div className="theme-options">
              {themeOptions.map((option) => (
                <label key={option.value} className="theme-option">
                  <input type="radio" name="theme" value={option.value} checked={theme === option.value}
                    onChange={() => { setTheme(option.value); setThemePreference(option.value); }} />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        {onOpenProjectSettings && <section className="settings-project-link" aria-labelledby="project-settings-link-title">
          <h3 id="project-settings-link-title">Project settings</h3>
          <p className="settings-help">Name, members, agent principles, templates and instructions for {projectName ? `“${projectName}”` : 'the current project'}. Shared with everyone in the project.</p>
          <button type="button" className="button button-secondary button-small" onClick={onOpenProjectSettings}>Open project settings…</button>
        </section>}
        <div className="modal-actions"><button type="button" className="button button-primary" onClick={onClose}>Done</button></div>
      </div>
    </dialog>
  );
}
