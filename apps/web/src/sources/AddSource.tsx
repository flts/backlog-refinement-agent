import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ApiError, useCreateSource, type NewSource } from '../api';
import { sourceErrorText } from './errors';
import { checkUploadFile, FILE_ACCEPT, formatMiB, MAX_UPLOAD_BYTES } from './limits';

type Feedback = { notice?: string; errors: string[] };
type UrlFailure = { url: string; name: string; reason: string };

export function AddSource({ projectId }: { projectId: string }) {
  const create = useCreateSource(projectId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ errors: [] });
  const [url, setUrl] = useState('');
  const [urlName, setUrlName] = useState('');
  const [urlFailure, setUrlFailure] = useState<UrlFailure>();
  const [pastedPage, setPastedPage] = useState('');
  const [showText, setShowText] = useState(false);
  const [textName, setTextName] = useState('');
  const [text, setText] = useState('');
  const busy = create.isPending;

  async function uploadFiles(files: File[]) {
    const errors: string[] = [];
    const added: string[] = [];
    for (const file of files) {
      const problem = checkUploadFile(file);
      if (problem) { errors.push(problem); continue; }
      try { await create.mutateAsync({ kind: 'file', file }); added.push(file.name); }
      catch (cause) { errors.push(`“${file.name}” was not added: ${sourceErrorText(cause)}`); }
    }
    setFeedback({ errors, notice: added.length ? `Added ${added.join(', ')}; indexing has started.` : undefined });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (!busy) void uploadFiles([...event.dataTransfer.files]);
  }

  async function submitUrl(source: NewSource & { kind: 'url' }, onDone: () => void) {
    setFeedback({ errors: [] });
    try {
      await create.mutateAsync(source);
      onDone();
      setFeedback({ errors: [], notice: 'Web page added; indexing has started.' });
    } catch (cause) {
      if (cause instanceof ApiError && cause.slug === 'url-fetch-failed' && !source.pastedText) {
        setUrlFailure({ url: source.url, name: source.name ?? '', reason: cause.detail || cause.title });
      } else setFeedback({ errors: [`The web page was not added: ${sourceErrorText(cause)}`] });
    }
  }

  function onUrlSubmit(event: FormEvent) {
    event.preventDefault();
    let parsed: URL;
    try { parsed = new URL(url.trim()); } catch { setFeedback({ errors: ['Enter a complete URL such as https://example.com/page.'] }); return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) { setFeedback({ errors: ['Enter an HTTP or HTTPS URL without credentials.'] }); return; }
    setUrlFailure(undefined);
    void submitUrl({ kind: 'url', url: parsed.href, name: urlName.trim() || undefined }, () => { setUrl(''); setUrlName(''); });
  }

  function onPastedPageSubmit(event: FormEvent) {
    event.preventDefault();
    if (!urlFailure) return;
    void submitUrl({ kind: 'url', url: urlFailure.url, name: urlFailure.name || undefined, pastedText: pastedPage }, () => { setUrlFailure(undefined); setPastedPage(''); setUrl(''); setUrlName(''); });
  }

  async function onTextSubmit(event: FormEvent) {
    event.preventDefault();
    setFeedback({ errors: [] });
    try {
      await create.mutateAsync({ kind: 'text', name: textName.trim(), text });
      setTextName(''); setText(''); setShowText(false);
      setFeedback({ errors: [], notice: 'Text added; indexing has started.' });
    } catch (cause) { setFeedback({ errors: [`The text was not added: ${sourceErrorText(cause)}`] }); }
  }

  return <section className="sources-add" aria-labelledby="sources-add-title" aria-busy={busy}>
    <h3 id="sources-add-title">Add a source</h3>
    <div className={`sources-dropzone${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <p>Drop files here, or</p>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => fileInput.current?.click()}>Choose files</button>
      <input ref={fileInput} type="file" multiple accept={FILE_ACCEPT} hidden aria-label="Choose files to add" data-testid="source-file-input"
        onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void uploadFiles(files); }} />
      <p className="sources-hint">PDF, TXT, MD, CSV or JSON, up to {formatMiB(MAX_UPLOAD_BYTES)} each.</p>
    </div>

    <form className="sources-url-form" onSubmit={onUrlSubmit}>
      <label>Web page URL<input type="text" inputMode="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/page" required disabled={busy} /></label>
      <label>Name <span className="sources-hint">(optional)</span><input value={urlName} onChange={(event) => setUrlName(event.target.value)} maxLength={200} disabled={busy} /></label>
      <button className="button button-secondary button-small" disabled={busy}>Add URL</button>
    </form>

    {urlFailure && <form className="sources-fallback" onSubmit={onPastedPageSubmit} aria-labelledby="sources-fallback-title">
      <h4 id="sources-fallback-title">The page could not be fetched</h4>
      <p role="alert">{urlFailure.reason}</p>
      <label>Paste the page text instead<textarea value={pastedPage} onChange={(event) => setPastedPage(event.target.value)} rows={5} required disabled={busy} /></label>
      <div className="sources-actions">
        <button className="button button-primary button-small" disabled={busy}>Add pasted text</button>
        <button type="button" className="button button-secondary button-small" onClick={() => setUrlFailure(undefined)}>Cancel</button>
      </div>
    </form>}

    {!showText && <button type="button" className="button button-secondary button-small" aria-expanded="false" onClick={() => setShowText(true)}>Paste text</button>}
    {showText && <form className="sources-text-form" onSubmit={(event) => void onTextSubmit(event)} aria-labelledby="sources-text-title">
      <h4 id="sources-text-title">Paste text</h4>
      <label>Name<input value={textName} onChange={(event) => setTextName(event.target.value)} maxLength={200} required disabled={busy} /></label>
      <label>Text<textarea value={text} onChange={(event) => setText(event.target.value)} rows={5} required disabled={busy} /></label>
      <div className="sources-actions">
        <button className="button button-primary button-small" disabled={busy}>Add text</button>
        <button type="button" className="button button-secondary button-small" onClick={() => setShowText(false)}>Cancel</button>
      </div>
    </form>}

    <div className="sources-feedback">
      <p role="status">{feedback.notice}</p>
      {feedback.errors.map((message) => <p key={message} role="alert" className="sources-error">{message}</p>)}
    </div>
  </section>;
}
