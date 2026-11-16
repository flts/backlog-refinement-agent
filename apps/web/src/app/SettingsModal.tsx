import React, { useRef, useState, type FormEvent } from 'react';
import { useModalDialog } from './useModalDialog';
import type { BacklogItemType } from '../domain/backlog-item';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { useAuth } from '../auth';
import { itemTypeLabel, itemTypes } from './labels';
import { getThemePreference, setThemePreference, type ThemePreference } from './theme';

type Tab = 'general' | 'backup' | BacklogItemType;
const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const tabs: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  ...itemTypes.map((type) => ({ id: type, label: itemTypeLabel[type] })),
  { id: 'backup', label: 'Backup' },
];

export function SettingsModal({ settings, onSave, onRestore, onClose, onExport, onImport }: {
  settings: UserSettings;
  onSave: (values: UserSettings) => void;
  onRestore: () => void;
  onClose: () => void;
  onExport: () => void;
  onImport: (file: File) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const dialog = useModalDialog(onClose, () => !importing);
  const auth = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const byType = (prefix: string) => Object.fromEntries(itemTypes.map((type) => [type, String(form.get(`${prefix}-${type}`) ?? '')]));
    onSave({
      instructions: String(form.get('instructions') ?? ''),
      principles: String(form.get('principles') ?? ''),
      templates: byType('template') as UserSettings['templates'],
      typeInstructions: byType('type-instructions') as UserSettings['typeInstructions'],
    });
  }

  function restore() {
    if (window.confirm('Restore ALL instructions and templates to the source defaults? Your customizations will be lost.')) onRestore();
  }

  function moveTab(event: React.KeyboardEvent, index: number) {
    const next = event.key === 'ArrowRight' ? index + 1
      : event.key === 'ArrowLeft' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    setTab(target.id);
    document.getElementById(`settings-tab-${target.id}`)?.focus();
  }

  return (
    <dialog className="modal-dialog" aria-labelledby="settings-title" {...dialog}>
      <form className="modal settings-modal" aria-busy={importing} onSubmit={submit} noValidate>
        <button type="button" className="close-button modal-close" onClick={onClose} disabled={importing} aria-label="Close settings"><span aria-hidden="true">×</span></button>
        <span className="eyebrow">Personalize your agent</span><h2 id="settings-title">Instructions & templates</h2>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" inert={importing}>
          {tabs.map((entry, index) => (
            <button key={entry.id} type="button" role="tab" id={`settings-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`settings-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1} className={`settings-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)} onKeyDown={(event) => moveTab(event, index)}>{entry.label}</button>
          ))}
        </div>
        <div className="settings-body" inert={importing}>
          <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={tab !== 'general'}>
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
            <label htmlFor="principles">Base refinement principles</label>
            <p className="settings-help">Stable rules applied to every backlog item. Restoring defaults reloads them from <code>src/defaults/instructions/principles.md</code>.</p>
            <textarea className="markdown-template-input" id="principles" name="principles" rows={12} defaultValue={settings.principles} />
            <label htmlFor="instructions">Additional agent instructions <span>Optional</span></label>
            <textarea id="instructions" name="instructions" rows={4} placeholder="Add local instructions for how the agent should refine your backlog…" defaultValue={settings.instructions} />
          </div>
          {itemTypes.map((type) => (
            <div key={type} role="tabpanel" id={`settings-panel-${type}`} aria-labelledby={`settings-tab-${type}`} hidden={tab !== type}>
              <label htmlFor={`type-instructions-${type}`}>{itemTypeLabel[type]} instructions</label>
              <p className="settings-help">Added to the base principles when refining a {itemTypeLabel[type].toLowerCase()}.</p>
              <textarea className="markdown-template-input" id={`type-instructions-${type}`} name={`type-instructions-${type}`} rows={8} defaultValue={settings.typeInstructions[type]} />
              <label htmlFor={`template-${type}`}>{itemTypeLabel[type]} template</label>
              <p className="settings-help">Plain Markdown: headings plus optional &lt;!-- hints --&gt; for the agent, which decides what to fill in. Keep &quot;Assumptions&quot; and &quot;Open questions&quot; sections (one &quot;- [ ] item&quot; per line) to get confirm/reject/resolve buttons.</p>
              <textarea className="markdown-template-input" id={`template-${type}`} name={`template-${type}`} rows={14} defaultValue={settings.templates[type]} />
            </div>
          ))}
          <div role="tabpanel" id="settings-panel-backup" aria-labelledby="settings-tab-backup" hidden={tab !== 'backup'}>
            <h3>Configuration backup</h3>
            <p className="settings-help">Export your saved instructions and templates as JSON. Save any changes before exporting. Project data is not included.</p>
            <button type="button" className="button button-secondary" onClick={onExport}>Export configuration</button>
            <p className="settings-help backup-import-help">Importing replaces saved instructions and templates and discards unsaved edits in this window. Project data is not changed.</p>
            <button type="button" className="button button-secondary" onClick={() => importInput.current?.click()}>Import configuration</button>
            <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file || !window.confirm('Importing replaces your saved configuration and discards unsaved edits in Settings. Continue?')) return;
              setImporting(true);
              try { await onImport(file); }
              finally { setImporting(false); }
            }} />
          </div>
        </div>
        {importing && <p className="settings-help" role="status">Importing configuration…</p>}
        <div className="modal-actions"><button type="button" className="button button-secondary" disabled={importing} onClick={restore}>Restore source defaults</button><button className="button button-primary" type="submit" disabled={importing}>Save customization</button></div>
      </form>
    </dialog>
  );
}
