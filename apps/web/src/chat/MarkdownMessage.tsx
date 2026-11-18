import type { Components, Options } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_URL = /^(https?:|mailto:)/i;

/** Only absolute http(s) and mailto URLs survive; relative, `javascript:`, `data:` and other schemes are dropped. */
export const safeUrl: NonNullable<Options['urlTransform']> = (url) => (SAFE_URL.test(url.trim()) ? url : '');

const components: Components = {
  a: ({ href, children }) => (href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>),
  // Images are never loaded: the agent's output must not make the browser fetch remote content.
  img: ({ src, alt }) => (typeof src === 'string' && src
    ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'Image link'}</a>
    : <span>{alt}</span>),
  table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
};

const plugins = [remarkGfm];

/**
 * Renders assistant output as Markdown (GFM). Raw HTML is never interpreted (it shows up as text), images become links
 * and unsafe URLs are removed. While `streaming`, a caret marks the end and `aria-busy` tells assistive technology
 * that the text is still changing (the transcript itself is not a live region, see `ChatPanel`).
 */
export function MarkdownMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown" aria-busy={streaming || undefined} data-streaming={streaming || undefined}>
      <Markdown remarkPlugins={plugins} urlTransform={safeUrl} components={components}>{text}</Markdown>
      {streaming && <span className="stream-caret" aria-hidden="true" />}
    </div>
  );
}
