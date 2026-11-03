import React, { useState, type FormEvent } from 'react';
import type { BacklogItemType } from '../domain/backlog-item';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { itemTypeLabel, itemTypes } from './labels';

type Tab = 'general' | BacklogItemType;
const tabs: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  ...itemTypes.map((type) => ({ id: type, label: itemTypeLabel[type] })),
];

export function SettingsModal({ settings, llmReady, onSave, onRestore, onClose }: {
  settings: UserSettings;
  llmReady: boolean;
  onSave: (values: UserSettings) => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('general');

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
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    setTab(target.id);
    document.getElementById(`settings-tab-${target.id}`)?.focus();
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal settings-modal" onSubmit={submit} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
        <button type="button" className="close-button modal-close" onClick={onClose} aria-label="Close">×</button>
        <span className="eyebrow">PERSONALIZE YOUR AGENT</span><h2>Instructions & templates</h2>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((entry, index) => (
            <button key={entry.id} type="button" role="tab" id={`settings-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`settings-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1} className={`settings-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)} onKeyDown={(event) => moveTab(event, index)}>{entry.label}</button>
          ))}
        </div>
        <div className="settings-body">
          <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={tab !== 'general'}>
            <div className="env-config-note"><strong>LLM connection</strong><span className={llmReady ? 'env-ready' : 'env-missing'}>{llmReady ? 'Endpoint and model detected' : 'Missing VITE_LLM_ENDPOINT or VITE_LLM_MODEL'}</span><code>VITE_LLM_ENDPOINT · VITE_LLM_MODEL</code><small>In local development only, LOCAL_LLM_API_KEY from .env.local is attached to requests. Production builds omit this key and send requests without browser-held credentials.</small></div>
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
        </div>
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={restore}>Restore source defaults</button><button className="button button-primary" type="submit">Save customization</button></div>
      </form>
    </div>
  );
}
