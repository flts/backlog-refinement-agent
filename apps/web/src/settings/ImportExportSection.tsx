import { useRef, useState } from 'react';
import { ApiError, useExportGuidance, useExportProject, useImportGuidance, type Project } from '../api';
import { downloadFile } from '../app/files';
import { errorText } from '../app/useNotifications';

const maxGuidanceBytes = 2 * 1024 * 1024;

function slug(name: string) {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
}

export function ImportExportSection({ project, isOwner, hasUnsaved, onImported }: { project: Project; isOwner: boolean; hasUnsaved: boolean; onImported: () => void }) {
  const exportGuidance = useExportGuidance(project.id);
  const importGuidance = useImportGuidance(project.id);
  const exportBackup = useExportProject();
  const fileInput = useRef<HTMLInputElement>(null);
  const [includeDefaults, setIncludeDefaults] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<string[]>([]);

  function reset() { setNotice(''); setError(''); setIssues([]); }

  function downloadGuidance() {
    reset();
    exportGuidance.mutate({ includeDefaults }, {
      onSuccess: (document) => { downloadFile(`${slug(project.name)}-guidance.json`, JSON.stringify(document, null, 2), 'application/json'); setNotice('Guidance exported (format v5).'); },
      onError: (cause) => setError(`Could not export the guidance: ${errorText(cause)}`),
    });
  }

  function downloadBackup() {
    reset();
    exportBackup.mutate(project, {
      onSuccess: ({ blob, filename }) => { downloadFile(filename, blob, 'application/json'); setNotice('Project backup exported.'); },
      onError: (cause) => setError(`Could not export the project: ${errorText(cause)}`),
    });
  }

  async function importFile(file: File) {
    reset();
    if (file.size > maxGuidanceBytes) { setError('The guidance file is larger than 2 MiB.'); return; }
    let document: unknown;
    try { document = JSON.parse(await file.text()); } catch { setError('The file is not valid JSON.'); return; }
    if (!document || typeof document !== 'object' || Array.isArray(document)) { setError('The file must contain a JSON object.'); return; }
    const warning = hasUnsaved ? ' Unsaved edits in the editors will be discarded.' : '';
    if (!window.confirm(`Replace all guidance overrides of “${project.name}” with the contents of ${file.name}? Anything not in the file falls back to the skill default.${warning}`)) return;
    importGuidance.mutate(document as Record<string, unknown>, {
      onSuccess: () => { onImported(); setNotice(`Guidance imported from ${file.name}.`); },
      onError: (cause) => {
        const found = cause instanceof ApiError ? cause.extensions.issues : undefined;
        if (Array.isArray(found) && found.length) {
          setError('The file was not imported. Fix these problems and try again:');
          setIssues(found.filter((issue): issue is string => typeof issue === 'string'));
        }
        else if (cause instanceof ApiError && cause.status === 422) setError(`The file was not imported: ${cause.detail ?? cause.title}`);
        else setError(`Could not import the guidance: ${errorText(cause)}`);
      },
    });
  }

  return <>
    <h3>Import / Export</h3>
    <section className="settings-block" aria-labelledby="guidance-export-title">
      <h4 id="guidance-export-title">Guidance (format v5)</h4>
      <p className="settings-help">Principles, type instructions and templates of this project, with the skill version each override is based on. Members can export; only owners can import.</p>
      <label className="settings-check"><input type="checkbox" checked={includeDefaults} onChange={(event) => setIncludeDefaults(event.target.checked)} /> Include skill defaults for entries without an override</label>
      <div className="guidance-actions">
        <button type="button" className="button button-secondary button-small" disabled={exportGuidance.isPending} onClick={downloadGuidance}>Export guidance</button>
        {isOwner && <button type="button" className="button button-secondary button-small" disabled={importGuidance.isPending} onClick={() => fileInput.current?.click()}>Import guidance</button>}
        <input ref={fileInput} type="file" hidden accept=".json,application/json" aria-label="Guidance file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
      </div>
      {!isOwner && <p className="settings-help">Only project owners can import guidance.</p>}
    </section>
    {isOwner && <section className="settings-block" aria-labelledby="backup-title">
      <h4 id="backup-title">Project backup (format v2)</h4>
      <p className="settings-help">Everything in the project: sources and files, items, relationships, revisions and guidance. Members and conversations are not included. To restore a backup, use “Import project” on the projects bar; it always creates a new project.</p>
      <div className="guidance-actions"><button type="button" className="button button-secondary button-small" disabled={exportBackup.isPending} onClick={downloadBackup}>Export project backup</button></div>
    </section>}
    <div role="status">{notice && <p className="guidance-meta">{notice}</p>}</div>
    {error && <div className="guidance-issues" role="alert">
      <p>{error}</p>
      {issues.length > 0 && <ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
    </div>}
  </>;
}
