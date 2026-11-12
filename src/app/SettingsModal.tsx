import React, { useRef, useState, type FormEvent } from 'react';
import type { BacklogItemType } from '../domain/backlog-item';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { fetchAvailableModels } from '../infrastructure/llm/availableModels';
import type { LlmOverrides } from '../infrastructure/llm/llmConfig';
import { isValidLlmEndpoint } from '../infrastructure/llm/apiUrl';
import { itemTypeLabel, itemTypes } from './labels';

type Tab = 'general' | 'backup' | BacklogItemType;
const tabs: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  ...itemTypes.map((type) => ({ id: type, label: itemTypeLabel[type] })),
  { id: 'backup', label: 'Backup' },
];

export function SettingsModal({ settings, llmReady, llm, llmEnvironment, onClearLlm, onSave, onRestore, onClose, onExport, onImport }: {
  settings: UserSettings;
  llmReady: boolean;
  llm: LlmOverrides;
  llmEnvironment: LlmOverrides;
  onClearLlm: () => void;
  onSave: (values: UserSettings, llm?: LlmOverrides) => void;
  onRestore: () => void;
  onClose: () => void;
  onExport: () => void;
  onImport: (file: File) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const [llmFormKey, setLlmFormKey] = useState(0);
  const [models, setModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState('');
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  async function loadModels() {
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
    const endpoint = value('llm-endpoint') || llmEnvironment.endpoint;
    if (!endpoint) { setModelStatus('Enter an endpoint first.'); return; }
    if (!isValidLlmEndpoint(endpoint)) { setModelStatus('Enter an HTTP(S) URL or a same-origin path such as /api.'); return; }
    setModelStatus('Loading models…');
    const found = await fetchAvailableModels(endpoint, value('llm-api-key') || llmEnvironment.apiKey);
    setModels(found);
    setModelStatus(found.length ? `${found.length} models found.` : 'No models returned by /v1/models; type the model name manually.');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const endpoint = String(form.get('llm-endpoint') ?? '').trim();
    const endpointInput = event.currentTarget.elements.namedItem('llm-endpoint');
    if (endpointInput instanceof HTMLInputElement) {
      endpointInput.setCustomValidity(endpoint && !isValidLlmEndpoint(endpoint)
        ? 'Enter an HTTP(S) URL or a same-origin path such as /api.'
        : '');
      if (!endpointInput.reportValidity()) return;
    }
    const byType = (prefix: string) => Object.fromEntries(itemTypes.map((type) => [type, String(form.get(`${prefix}-${type}`) ?? '')]));
    onSave({
      instructions: String(form.get('instructions') ?? ''),
      principles: String(form.get('principles') ?? ''),
      templates: byType('template') as UserSettings['templates'],
      typeInstructions: byType('type-instructions') as UserSettings['typeInstructions'],
    }, {
      endpoint: String(form.get('llm-endpoint') ?? ''),
      model: String(form.get('llm-model') ?? ''),
      apiKey: String(form.get('llm-api-key') ?? ''),
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
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!importing && event.target === event.currentTarget) onClose(); }}>
      <form className="modal settings-modal" aria-busy={importing} onSubmit={submit} onKeyDown={(event) => { if (!importing && event.key === 'Escape') onClose(); }}>
        <button type="button" className="close-button modal-close" onClick={onClose} disabled={importing} aria-label="Close">×</button>
        <span className="eyebrow">PERSONALIZE YOUR AGENT</span><h2>Instructions & templates</h2>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" inert={importing}>
          {tabs.map((entry, index) => (
            <button key={entry.id} type="button" role="tab" id={`settings-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`settings-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1} className={`settings-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)} onKeyDown={(event) => moveTab(event, index)}>{entry.label}</button>
          ))}
        </div>
        <div className="settings-body" inert={importing}>
          <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={tab !== 'general'}>
            <fieldset className="llm-connection" key={llmFormKey}>
              <legend>LLM connection</legend>
              <span className={llmReady ? 'env-ready' : 'env-missing'}>{llmReady ? 'Endpoint and model configured' : 'Endpoint or model missing'}</span>
              <p className="settings-help">Values entered here are stored in this browser (localStorage) and override config.json. Leave a field empty to use the configured value. They are not part of the configuration export.</p>
              <label htmlFor="llm-endpoint">Base URL {llmEnvironment.endpoint && !llm.endpoint && <span>From config.json</span>}{llm.endpoint && <span>Saved override</span>}</label>
              <input id="llm-endpoint" name="llm-endpoint" type="text" inputMode="url" autoComplete="off" defaultValue={llm.endpoint} placeholder={llmEnvironment.endpoint || 'https://your-proxy.example'} />
              <small className="settings-help">Use an absolute HTTP(S) URL or a same-origin path such as /api.</small>
              <label htmlFor="llm-model">Model {llmEnvironment.model && !llm.model && <span>From config.json</span>}{llm.model && <span>Saved override</span>}</label>
              <input id="llm-model" name="llm-model" type="text" list="llm-model-options" autoComplete="off" defaultValue={llm.model} placeholder={llmEnvironment.model || 'Type a model name or load the list'} />
              <datalist id="llm-model-options">{models.map((id) => <option key={id} value={id} />)}</datalist>
              <div><button type="button" className="button button-secondary button-small" onClick={() => void loadModels()}>Load models from /v1/models</button> <small className="settings-help" role="status">{modelStatus}</small></div>
              <label htmlFor="llm-api-key">API key {llmEnvironment.apiKey && !llm.apiKey && <span>From development config</span>}{llm.apiKey && <span>Saved override</span>}</label>
              <input id="llm-api-key" name="llm-api-key" type="password" autoComplete="new-password" defaultValue={llm.apiKey} placeholder={llmEnvironment.apiKey ? '•••••••• (from development config, type to override)' : 'Optional'} />
              <small className="settings-help">The key is sent from your browser with each request, so only use it with a trusted endpoint.</small>
              <div><button type="button" className="button button-secondary button-small" disabled={!llm.endpoint && !llm.model && !llm.apiKey} onClick={() => { onClearLlm(); setLlmFormKey((key) => key + 1); }}>Remove saved connection</button></div>
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
            <p className="settings-help">Export your saved instructions and templates as JSON. Save any changes before exporting. Connection settings and project data are not included.</p>
            <button type="button" className="button button-secondary" onClick={onExport}>Export configuration</button>
            <p className="settings-help backup-import-help">Importing replaces saved instructions and templates and discards unsaved edits in this window. Project data and connection settings are not changed.</p>
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
    </div>
  );
}
