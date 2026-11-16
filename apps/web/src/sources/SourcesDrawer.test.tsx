import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { backlogKeys, TestBacklogApiProvider, useSources, type SourceList } from '../api';
import { createFakeBacklogApi, makeProject, makeSource } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi, testQueryClient } from '../test/render';
import { SourcesDrawer } from './SourcesDrawer';
import { MAX_UPLOAD_BYTES } from './limits';

const problem = (status: number, slug: string, extra: Record<string, unknown> = {}, detail?: string) =>
  new Response(JSON.stringify({ type: `/problems/${slug}`, title: slug, status, detail, ...extra }), { status, headers: { 'Content-Type': 'application/problem+json' } });

const open = (api = createFakeBacklogApi({ projects: [makeProject()] }), onClose = vi.fn()) => ({ api, onClose, ...renderWithApi(<SourcesDrawer projectId="p1" projectName="Alpha" onClose={onClose} />, api) });
// jsdom's FormData/File are not accepted by Node's Request (which the API client builds), so the multipart tests use Node's own.
let NodeFile: typeof File;
beforeAll(async () => {
  const nodeModule = 'node:buffer';
  const nodeBuffer = await import(/* @vite-ignore */ nodeModule) as { File: typeof File };
  NodeFile = nodeBuffer.File;
  const parsed = await new Response(new URLSearchParams()).formData();
  vi.stubGlobal('FormData', parsed.constructor);
  vi.stubGlobal('File', NodeFile);
});
const makeFile = (content: string, name: string, type: string) => new NodeFile([content], name, { type });
const fileInput = () => screen.getByTestId('source-file-input');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('SourcesDrawer', () => {
  it('uploads picked files as multipart and reports them', async () => {
    const { api } = open();
    const file = makeFile('hello', 'notes.txt', 'text/plain');
    fireEvent.change(fileInput(), { target: { files: [file] } });
    expect(await screen.findByText(/Added notes.txt/)).toBeInTheDocument();
    const call = api.callsTo('POST', /sources$/)[0];
    expect(call.headers.get('Content-Type')).toMatch(/^multipart\/form-data/);
    expect((call.body as { file: File }).file.name).toBe('notes.txt');
    expect(await screen.findByText('notes.txt', { selector: 'strong' })).toBeInTheDocument();
  });

  it('accepts dropped files', async () => {
    const { api } = open();
    const zone = screen.getByText('Drop files here, or').parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('a,b', 'data.csv', 'text/csv')] } });
    await waitFor(() => expect(api.callsTo('POST', /sources$/)).toHaveLength(1));
  });

  it('rejects oversized and unsupported files before uploading', async () => {
    const { api } = open();
    const big = makeFile('x', 'huge.pdf', 'application/pdf');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    fireEvent.change(fileInput(), { target: { files: [big, makeFile('x', 'photo.png', 'image/png')] } });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('“huge.pdf” was not added: it is 10.0 MiB and the limit is 10.0 MiB');
    expect(alerts[1]).toHaveTextContent('only PDF, TXT, MD, CSV and JSON');
    expect(api.callsTo('POST', /sources$/)).toHaveLength(0);
  });

  it('adds a URL, and falls back to pasted text when the server cannot fetch it', async () => {
    const user = userEvent.setup();
    const { api } = open();
    await user.type(screen.getByLabelText(/Web page URL/), 'https://example.com/spec');
    api.state.failNext = problem(422, 'url-fetch-failed', {}, 'The host is not reachable. You can paste the page text instead.');
    await user.click(screen.getByRole('button', { name: 'Add URL' }));
    expect(await screen.findByText(/host is not reachable/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Paste the page text instead'), 'Page text');
    await user.click(screen.getByRole('button', { name: 'Add pasted text' }));
    await screen.findByText('Web page added; indexing has started.');
    const calls = api.callsTo('POST', /sources$/);
    expect(calls[0].body).toEqual({ url: 'https://example.com/spec' });
    expect(calls[1].body).toEqual({ url: 'https://example.com/spec', pastedText: 'Page text' });
    expect(screen.queryByLabelText('Paste the page text instead')).toBeNull();
  });

  it('validates the URL on the client', async () => {
    const user = userEvent.setup();
    const { api } = open();
    await user.type(screen.getByLabelText(/Web page URL/), 'ftp://example.com/x');
    await user.click(screen.getByRole('button', { name: 'Add URL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP or HTTPS');
    expect(api.callsTo('POST', /sources$/)).toHaveLength(0);
  });

  it('adds pasted text with a name', async () => {
    const user = userEvent.setup();
    const { api } = open();
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    await user.type(screen.getByLabelText('Name'), 'Interview');
    await user.type(screen.getByLabelText('Text'), 'Notes');
    await user.click(screen.getByRole('button', { name: 'Add text' }));
    await screen.findByText('Text added; indexing has started.');
    expect(api.callsTo('POST', /sources$/)[0].body).toEqual({ text: 'Notes', name: 'Interview' });
  });

  it('shows size, pages, kind, budget meter and index status badges with the error text', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [
      makeSource({ id: 'a', name: 'Handbook', kind: 'file', hasFile: true, charCount: 4200, pageCount: 3, indexStatus: 'indexed' }),
      makeSource({ id: 'b', name: 'Queued', indexStatus: 'pending' }),
      makeSource({ id: 'c', name: 'Busy', indexStatus: 'indexing' }),
      makeSource({ id: 'd', name: 'Broken', indexStatus: 'failed', indexError: 'Embedding gateway unavailable' }),
      makeSource({ id: 'e', name: 'Skipped', indexStatus: 'skipped' }),
    ] });
    api.state.sources[0].mode = 'pinned';
    open(api);
    expect(await screen.findByText('4,200 characters · 3 pages')).toBeInTheDocument();
    for (const label of ['Indexed', 'Waiting to index', 'Indexing…', 'Indexing failed', 'Not indexed']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('Embedding gateway unavailable')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Pinned budget' })).toHaveAttribute('aria-valuetext', expect.stringContaining('of 100,000 characters pinned'));
  });

  it('changes the mode with If-Match and explains a pinned-budget rejection', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource({ version: 4 })] });
    open(api);
    const group = await screen.findByRole('radiogroup', { name: 'Mode of Spec' });
    expect(within(group).getByRole('radio', { name: 'Searchable' })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'Pinned' }));
    await waitFor(() => expect(api.state.sources[0].mode).toBe('pinned'));
    expect(api.callsTo('PATCH', /sources\/s1$/)[0].headers.get('If-Match')).toBe('"4"');

    api.state.failNext = problem(422, 'pinned-budget-exceeded', { used: 95000, limit: 100000, required: 12000 });
    await user.click(within(group).getByRole('radio', { name: 'Excluded' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('95,000 of 100,000 characters are already pinned and this source needs 12,000');
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Pinned' })).toBeChecked());
  });

  it('downloads the original of file sources only', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource({ id: 'f', name: 'Brief.pdf', kind: 'file', hasFile: true, mediaType: 'application/pdf' }), makeSource({ id: 'u', name: 'Page' })] });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    open(api);
    await user.click(await screen.findByRole('button', { name: 'Actions for Page' }));
    expect(screen.queryByRole('menuitem', { name: 'Download original' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actions for Brief.pdf' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download original' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.callsTo('GET', /sources\/f\/file$/)).toHaveLength(1);
  });

  it('reindexes, renames and removes only after confirmation', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource()] });
    open(api);
    await user.click(await screen.findByRole('button', { name: 'Actions for Spec' }));
    await user.click(screen.getByRole('menuitem', { name: 'Reindex' }));
    await waitFor(() => expect(api.callsTo('POST', /sources\/s1\/reindex$/)).toHaveLength(1));
    expect(await screen.findByText('Waiting to index')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for Spec' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('New name for Spec');
    await user.clear(input);
    await user.type(input, 'Specification{Enter}');
    await waitFor(() => expect(api.state.sources[0].name).toBe('Specification'));

    await user.click(screen.getByRole('button', { name: 'Actions for Specification' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    expect(api.callsTo('DELETE', /sources\/s1$/)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.state.sources).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Actions for Specification' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    await user.click(screen.getByRole('button', { name: 'Remove source' }));
    await waitFor(() => expect(api.state.sources).toHaveLength(0));
  });

  it('explains what is sent where', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByText('What can be sent, and where'));
    expect(screen.getByText(/full text goes with every agent request to the agent-service/)).toBeInTheDocument();
    expect(screen.getByText(/never sent to the agent-service or the gateway/)).toBeInTheDocument();
    expect(screen.getByText(/Every member of this project can download the originals/)).toBeInTheDocument();
  });

  it('is a modal dialog that gets focus and closes on Escape', async () => {
    const user = userEvent.setup();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { onClose } = open();
    expect(showModal).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close sources' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has no axe violations', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource({ indexStatus: 'failed', indexError: 'Boom' }), makeSource({ id: 's2', name: 'Doc', kind: 'file', hasFile: true })] });
    const { baseElement } = open(api);
    await screen.findByText('Boom');
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      await expectNoAxeViolations(baseElement);
    }
    delete document.documentElement.dataset.theme;
  });
});

describe('source list polling', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });

  it('refetches every 5 s while a source is pending or indexing and stops when none remain', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource({ indexStatus: 'indexing' })] });
    const queryClient = testQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => <TestBacklogApiProvider client={api.client} queryClient={queryClient}>{children}</TestBacklogApiProvider>;
    const { result } = renderHook(() => useSources('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const lists = () => api.callsTo('GET', /sources$/).length;
    expect(lists()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(5100));
    expect(lists()).toBe(2);
    api.state.sources[0].indexStatus = 'indexed';
    await act(() => vi.advanceTimersByTimeAsync(5100));
    expect(lists()).toBe(3);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(queryClient.getQueryData<SourceList>(backlogKeys.sources('p1'))?.items[0].indexStatus).toBe('indexed');
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(lists()).toBe(3);
  });
});
