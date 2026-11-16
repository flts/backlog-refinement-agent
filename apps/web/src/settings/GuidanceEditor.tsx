import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError, isVersionConflict, useResetGuidance, useSaveGuidance, useGuidance,
  type DefaultGuidance, type DefaultGuidanceEntry, type GuidanceEntry, type GuidanceTarget,
} from '../api';
import { errorText } from '../app/useNotifications';
import { DiffView } from './DiffView';
import { patchGuidanceEntry } from './guidanceCache';

export function defaultFor(defaults: DefaultGuidance | undefined, target: GuidanceTarget): DefaultGuidanceEntry | undefined {
  if (!defaults) return undefined;
  if (target.kind === 'principles') return defaults.principles;
  return (target.kind === 'template' ? defaults.templates : defaults.typeInstructions)[target.itemType];
}

/** 1-based number of the first line that contains a `{{…}}` placeholder, which templates must not use. */
export function placeholderLine(text: string): number | undefined {
  const index = text.split('\n').findIndex((line) => line.includes('{{'));
  return index === -1 ? undefined : index + 1;
}

function issuesOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const issues = error.extensions.issues;
  return Array.isArray(issues) ? issues.filter((issue): issue is string => typeof issue === 'string') : [];
}

type Props = {
  projectId: string;
  target: GuidanceTarget;
  label: string;
  help: string;
  entry: GuidanceEntry;
  defaults: DefaultGuidance | undefined;
  readOnly: boolean;
  /** `undefined` while the text is unchanged from the server; otherwise the edited text. */
  draft: string | undefined;
  onDraftChange: (value: string | undefined) => void;
  rows?: number;
};

export function GuidanceEditor({ projectId, target, label, help, entry, defaults, readOnly, draft, onDraftChange, rows = 12 }: Props) {
  const id = useId();
  const queryClient = useQueryClient();
  const guidanceQuery = useGuidance(projectId);
  const save = useSaveGuidance(projectId);
  const reset = useResetGuidance(projectId);
  const [comparing, setComparing] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');

  const text = draft ?? entry.content;
  const dirty = draft !== undefined && draft !== entry.content;
  const defaultEntry = defaultFor(defaults, target);
  const badLine = target.kind === 'template' ? placeholderLine(text) : undefined;
  const busy = save.isPending || reset.isPending;
  const isOverride = entry.source === 'project';

  function clearMessages() { setIssues([]); setConflict(false); setFailure(''); setNotice(''); }

  function handle(cause: unknown, action: string) {
    if (isVersionConflict(cause)) { setConflict(true); return; }
    const found = issuesOf(cause);
    if (found.length) setIssues(found);
    else setFailure(`${action}: ${errorText(cause)}`);
  }

  function submit() {
    clearMessages();
    save.mutate({ target, entry, content: text, baseSkillVersion: entry.defaultVersion }, {
      onSuccess: (saved) => { patchGuidanceEntry(queryClient, projectId, target, saved); onDraftChange(undefined); setNotice('Saved.'); },
      onError: (cause) => handle(cause, 'Could not save'),
    });
  }

  function resetToDefault() {
    if (!window.confirm(`Reset “${label}” to the skill default${defaultEntry ? ` (v${defaultEntry.version})` : ''}? The project override is deleted.`)) return;
    clearMessages();
    reset.mutate({ target, entry }, {
      onSuccess: (restored) => { if (restored) patchGuidanceEntry(queryClient, projectId, target, restored); onDraftChange(undefined); setNotice('Reset to the skill default.'); },
      onError: (cause) => handle(cause, 'Could not reset'),
    });
  }

  async function keepMine() {
    await guidanceQuery.refetch();
    setConflict(false);
  }

  async function loadTheirs() {
    await guidanceQuery.refetch();
    onDraftChange(undefined);
    setConflict(false);
  }

  const describedBy = [`${id}-help`, badLine ? `${id}-placeholder` : '', readOnly ? 'settings-readonly-note' : ''].filter(Boolean).join(' ');
  const compareId = `${id}-compare`;

  return <section className="guidance-editor" aria-labelledby={`${id}-label`}>
    <div className="guidance-head">
      <label id={`${id}-label`} htmlFor={`${id}-text`}>{label}</label>
      <ul className="guidance-badges" aria-label={`Status of ${label}`}>
        {isOverride ? <li className="badge badge-override">Project override</li> : <li className="badge">Skill default v{entry.defaultVersion}</li>}
        {isOverride && entry.differsFromDefault && <li className="badge badge-differs">Differs from skill default v{entry.defaultVersion}</li>}
        {isOverride && entry.outdated && <li className="badge badge-outdated">Outdated: based on v{entry.baseSkillVersion ?? 'unknown'}</li>}
        {dirty && <li className="badge badge-unsaved">Unsaved changes</li>}
      </ul>
    </div>
    <p className="settings-help" id={`${id}-help`}>{help}</p>
    <textarea id={`${id}-text`} className="markdown-template-input guidance-text" rows={rows} value={text} readOnly={readOnly} spellCheck={false}
      aria-describedby={describedBy} aria-invalid={badLine ? true : undefined}
      onChange={(event) => { clearMessages(); onDraftChange(event.target.value === entry.content ? undefined : event.target.value); }} />
    {badLine && <p className="field-error" id={`${id}-placeholder`}>Line {badLine} contains a {'{{…}}'} placeholder; templates must be placeholder-free Markdown.</p>}
    {issues.length > 0 && <div className="guidance-issues" role="alert">
      <p>The server rejected this text:</p>
      <ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    </div>}
    {failure && <p className="field-error" role="alert">{failure}</p>}
    {conflict && <div className="guidance-issues" role="alert">
      <p><strong>Someone else changed this guidance.</strong> Load their version to see it, or keep your text and save again to replace theirs.</p>
      <div className="guidance-actions">
        <button type="button" className="button button-secondary button-small" onClick={() => void loadTheirs()}>Reload their version</button>
        <button type="button" className="button button-secondary button-small" onClick={() => void keepMine()}>Keep my text</button>
      </div>
    </div>}
    <div className="guidance-actions">
      {!readOnly && <button type="button" className="button button-primary button-small" disabled={!dirty || busy || Boolean(badLine)} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</button>}
      {!readOnly && <button type="button" className="button button-secondary button-small" disabled={!isOverride || busy} onClick={resetToDefault}>Reset to default</button>}
      <button type="button" className="button button-secondary button-small" aria-expanded={comparing} aria-controls={compareId} disabled={!defaultEntry} onClick={() => setComparing((open) => !open)}>
        {comparing ? 'Hide comparison' : 'Compare with default'}
      </button>
      <span className="guidance-meta" role="status">{notice}</span>
    </div>
    {comparing && defaultEntry && <DiffView id={compareId} before={defaultEntry.content} after={text}
      beforeLabel={`skill default v${defaultEntry.version}`} afterLabel={dirty ? 'your edited text' : isOverride ? 'the project override' : 'the effective text'} />}
  </section>;
}
