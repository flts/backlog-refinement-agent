import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFileText, extractUrlText, SOURCE_LIMITS } from './source-extraction';

function file(name: string, value: string | Uint8Array, type = ''): File {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } as File;
}

afterEach(() => vi.unstubAllGlobals());

describe('local source extraction', () => {
  it('reads UTF-8 Markdown and reports unsupported or invalid files', async () => {
    await expect(extractFileText(file('notes.md', '# Hello\nWorld'))).resolves.toBe('# Hello\nWorld');
    await expect(extractFileText(file('picture.png', 'data', 'image/png'))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(extractFileText(file('notes.txt', new Uint8Array([0xff])))).rejects.toMatchObject({ code: 'invalid-text' });
  });

  it('rejects oversized files and text', async () => {
    await expect(extractFileText({ ...file('large.txt', ''), size: SOURCE_LIMITS.bytes + 1 } as File))
      .rejects.toMatchObject({ code: 'too-large' });
    await expect(extractFileText(file('large.txt', 'x'.repeat(SOURCE_LIMITS.text + 1))))
      .rejects.toMatchObject({ code: 'too-large' });
  });

  it('reports read failures', async () => {
    const broken = { ...file('notes.txt', ''), arrayBuffer: () => Promise.reject(new Error('disk')) } as File;
    await expect(extractFileText(broken)).rejects.toMatchObject({ code: 'read-failed' });
  });
});

describe('URL source extraction', () => {
  it('extracts readable text from inert HTML without script or navigation content', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      '<html><head><title>Title</title></head><body><nav>Menu</nav><main><h1>Hello</h1><p>First <b>bold</b> sentence.</p><script>window.injected = true</script><img src="https://other.invalid/image"><p hidden>Hidden</p><p>Second<br>line</p></main></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    ));
    vi.stubGlobal('fetch', fetcher);
    await expect(extractUrlText('https://example.test/article')).resolves.toBe('Hello\n\nFirst bold sentence.\n\nSecond\nline');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(new URL('https://example.test/article'), {
      method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    expect((window as unknown as { injected?: boolean }).injected).toBeUndefined();
  });

  it('accepts UTF-8 text responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Plain text', { headers: { 'content-type': 'text/plain' } })));
    await expect(extractUrlText('http://example.test')).resolves.toBe('Plain text');
  });

  it('reports invalid URLs, CORS/network, HTTP and content-type errors', async () => {
    await expect(extractUrlText('file:///etc/passwd')).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(extractUrlText('https://user:pass@example.test')).rejects.toMatchObject({ code: 'invalid-url' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(extractUrlText('https://example.test')).rejects.toMatchObject({ code: 'fetch-failed', message: expect.stringContaining('CORS') });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('failure', { status: 403 })));
    await expect(extractUrlText('https://example.test')).rejects.toMatchObject({ code: 'http-error' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data', { headers: { 'content-type': 'application/pdf' } })));
    await expect(extractUrlText('https://example.test')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('enforces declared and streamed byte limits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', {
      headers: { 'content-type': 'text/plain', 'content-length': String(SOURCE_LIMITS.bytes + 1) },
    })));
    await expect(extractUrlText('https://example.test')).rejects.toMatchObject({ code: 'too-large' });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(SOURCE_LIMITS.bytes + 1)); },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/plain' } })));
    await expect(extractUrlText('https://example.test')).rejects.toMatchObject({ code: 'too-large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
