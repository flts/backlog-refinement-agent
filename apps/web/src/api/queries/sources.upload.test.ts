// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFakeBacklogApi, makeProject } from '../../test/fakeBacklogApi';
import { postSource } from './sources';

// Node's own FormData/File (jsdom's are not accepted by Node's Request).
describe('postSource', () => {
  it('uploads the original file as multipart/form-data with name and mode', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    const source = await postSource(api.client, 'p1', { kind: 'file', file: new File(['hello'], 'notes.txt', { type: 'text/plain' }), mode: 'pinned' });
    const call = api.callsTo('POST', /sources$/)[0];
    expect(call.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect((call.body as { file: File; mode: string }).file.name).toBe('notes.txt');
    expect((call.body as { mode: string }).mode).toBe('pinned');
    expect(source.kind).toBe('file');
  });

  it('sends a URL with optional pasted text as JSON', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    await postSource(api.client, 'p1', { kind: 'url', url: 'https://example.com/a', pastedText: 'fallback', name: 'Spec' });
    expect(api.callsTo('POST', /sources$/)[0].body).toEqual({ url: 'https://example.com/a', pastedText: 'fallback', name: 'Spec' });
  });
});
