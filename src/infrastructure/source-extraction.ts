import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

/** Limits apply to both local files and fetched responses. Text limits are UTF-16 code units. */
export const SOURCE_LIMITS = {
  bytes: 10 * 1024 * 1024,
  text: 1_000_000,
  pdfPages: 200,
} as const;

export type SourceExtractionErrorCode =
  | 'unsupported'
  | 'too-large'
  | 'read-failed'
  | 'invalid-text'
  | 'invalid-url'
  | 'fetch-failed'
  | 'http-error'
  | 'encrypted-pdf'
  | 'invalid-pdf'
  | 'no-text';

export class SourceExtractionError extends Error {
  constructor(public readonly code: SourceExtractionErrorCode, message: string) {
    super(message);
    this.name = 'SourceExtractionError';
  }
}

const textExtensions = /\.(txt|md|markdown|mdown|csv|tsv|log|rst|text)$/i;
const textTypes = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'text/tab-separated-values']);

function mediaType(value: string): string {
  return value.split(';', 1)[0].trim().toLowerCase();
}

function tooLarge(): SourceExtractionError {
  return new SourceExtractionError('too-large', 'Source exceeds the extraction size limit.');
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SourceExtractionError('invalid-text', 'Source is not valid UTF-8 text.');
  }
}

function checkText(text: string): string {
  if (text.length > SOURCE_LIMITS.text) throw tooLarge();
  return text;
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = getDocument({ data: bytes, enableXfa: false, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > SOURCE_LIMITS.pdfPages) throw tooLarge();
    const pages: string[] = [];
    let length = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      try {
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          text += item.str + (item.hasEOL ? '\n' : ' ');
          if (length + text.length > SOURCE_LIMITS.text) throw tooLarge();
        }
        text = text.trim();
        length += text.length + (pages.length ? 2 : 0);
        if (length > SOURCE_LIMITS.text) throw tooLarge();
        pages.push(text);
      } finally {
        page.cleanup();
      }
    }
    const result = pages.join('\n\n').trim();
    if (!result) throw new SourceExtractionError('no-text', 'PDF contains no selectable text; OCR is not supported.');
    return result;
  } catch (error) {
    if (error instanceof SourceExtractionError) throw error;
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new SourceExtractionError('encrypted-pdf', 'Password-protected PDF files are not supported.');
    }
    throw new SourceExtractionError('invalid-pdf', 'Could not extract text from the PDF; it may be malformed.');
  } finally {
    await task.destroy();
  }
}

/** Extract selectable PDF text or UTF-8 text from a user-selected local file. */
export async function extractFileText(file: File): Promise<string> {
  if (file.size > SOURCE_LIMITS.bytes) throw tooLarge();
  const type = mediaType(file.type);
  const pdf = type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!pdf && !textExtensions.test(file.name) && !textTypes.has(type)) {
    throw new SourceExtractionError('unsupported', 'Unsupported file type. Select a PDF or UTF-8 text file.');
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new SourceExtractionError('read-failed', 'Could not read the selected file.');
  }
  if (bytes.byteLength > SOURCE_LIMITS.bytes) throw tooLarge();
  return pdf ? extractPdf(bytes) : checkText(decodeText(bytes));
}

const ignoredElements = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
  'SVG', 'MATH', 'HEAD', 'TITLE', 'NAV', 'FOOTER', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
]);
const blockElements = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DIV', 'DL', 'DT', 'DD',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
  'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
]);

function htmlToText(html: string): string {
  // Template content is inert: it is never attached to the document or executed.
  const template = document.createElement('template');
  template.innerHTML = html;
  const parts: string[] = [];
  let length = 0;
  const append = (value: string) => {
    length += value.length;
    if (length > SOURCE_LIMITS.text) throw tooLarge();
    parts.push(value);
  };
  const visit = (root: Node) => {
    // Iterative traversal avoids a call-stack overflow on deeply nested markup.
    const stack: Array<{ node: Node; closing: boolean }> = [{ node: root, closing: false }];
    while (stack.length) {
      const { node, closing } = stack.pop()!;
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.nodeValue ?? '');
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (ignoredElements.has(element.tagName) || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') continue;
        const block = blockElements.has(element.tagName);
        if (block) append('\n');
        if (closing) continue;
        if (block && node.childNodes.length) stack.push({ node, closing: true });
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], closing: false });
      } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], closing: false });
      }
    }
  };
  visit(template.content);
  return parts.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function readResponse(response: Response): Promise<Uint8Array> {
  const declaredSize = response.headers.get('content-length');
  if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > SOURCE_LIMITS.bytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > SOURCE_LIMITS.bytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch an explicit HTTP(S) URL in the browser; the server must allow CORS. */
export async function extractUrlText(input: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    throw new SourceExtractionError('invalid-url', 'Enter an absolute HTTP or HTTPS URL without credentials.');
  }
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new SourceExtractionError('fetch-failed', 'Could not fetch the URL. The server may not allow CORS or may be unreachable.');
  }
  if (!response.ok) throw new SourceExtractionError('http-error', `URL request failed with HTTP ${response.status}.`);
  const type = mediaType(response.headers.get('content-type') ?? '');
  const html = type === 'text/html' || type === 'application/xhtml+xml';
  if (!html && !textTypes.has(type)) {
    await response.body?.cancel();
    throw new SourceExtractionError('unsupported', 'URL must return HTML or UTF-8 text.');
  }
  let bytes: Uint8Array;
  try {
    bytes = await readResponse(response);
  } catch (error) {
    if (error instanceof SourceExtractionError) throw error;
    throw new SourceExtractionError('fetch-failed', 'Could not read the URL response.');
  }
  const text = decodeText(bytes);
  return html ? htmlToText(text) : checkText(text);
}
