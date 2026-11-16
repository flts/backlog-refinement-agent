import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Projects } from './Projects';
import { createFakeBacklogApi, makeItem, makeProject, makeSource } from '../test/fakeBacklogApi';
import { renderWithApi } from '../test/render';
import { expectNoAxeViolations } from '../test/axe';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('projects screen', () => {
  it('lists the projects from the server and restores the selected one', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject({ id: 'alpha', name: 'Alpha' }), makeProject({ id: 'beta', name: 'Beta' })] });
    localStorage.setItem('selected-project-id', 'beta');
    renderWithApi(<Projects />, api);
    expect(await screen.findByLabelText('Choose project')).toHaveValue('beta');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Choose project'), 'alpha');
    await waitFor(() => expect(localStorage.getItem('selected-project-id')).toBe('alpha'));
  });

  it('falls back to the first project when the remembered one is gone', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject({ id: 'alpha', name: 'Alpha' })] });
    localStorage.setItem('selected-project-id', 'deleted');
    renderWithApi(<Projects />, api);
    expect(await screen.findByLabelText('Choose project')).toHaveValue('alpha');
    await waitFor(() => expect(localStorage.getItem('selected-project-id')).toBe('alpha'));
  });

  it('creates a project on the server and switches to it', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi();
    renderWithApi(<Projects />, api);
    expect(await screen.findByText('Create or import a project to start a backlog.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New project name'), 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.getByLabelText('Choose project')).toHaveDisplayValue('Alpha'));
    expect(api.callsTo('POST', /^\/projects$/)[0].body).toEqual({ name: 'Alpha' });
    expect(await screen.findByText('Project created.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Create first item' })).toBeInTheDocument();
  });

  it('renames a project with If-Match and tells when someone else changed it first', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject({ version: 3 })] });
    vi.spyOn(window, 'prompt').mockReturnValue('Renamed');
    renderWithApi(<Projects />, api);
    await user.click(await screen.findByRole('button', { name: 'Rename project' }));
    await waitFor(() => expect(screen.getByLabelText('Choose project')).toHaveDisplayValue('Renamed'));
    expect(api.callsTo('PATCH', /^\/projects\/p1$/)[0].headers.get('If-Match')).toBe('"3"');

    api.state.projects[0].version = 9;
    vi.mocked(window.prompt).mockReturnValue('Again');
    await user.click(screen.getByRole('button', { name: 'Rename project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this project; reload to see their changes.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('deletes a project after confirmation', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject({ id: 'a', name: 'Alpha' }), makeProject({ id: 'b', name: 'Beta' })] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithApi(<Projects />, api);
    await screen.findByLabelText('Choose project');
    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(api.callsTo('DELETE', /^\/projects\//)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(screen.getByLabelText('Choose project')).toHaveDisplayValue('Beta'));
    expect(api.callsTo('DELETE', /^\/projects\/a$/)).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('hides owner actions from contributors', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject({ role: 'contributor' })] });
    renderWithApi(<Projects />, api);
    await screen.findByLabelText('Choose project');
    for (const name of ['Rename project', 'Delete project', 'Export project']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('button', { name: 'Import project' })).toBeInTheDocument();
  });

  it('exports through the backup endpoint and imports a file as a new project', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    const download = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(download);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithApi(<Projects />, api);
    await user.click(await screen.findByRole('button', { name: 'Export project' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(api.callsTo('GET', /^\/projects\/p1\/backup$/)).toHaveLength(1);

    const input = container.querySelector<HTMLInputElement>('input[accept=".json,application/json"]')!;
    fireEvent.change(input, { target: { files: [new File(['{}'], 'backup.json', { type: 'application/json' })] } });
    await waitFor(() => expect(screen.getByLabelText('Choose project')).toHaveDisplayValue('Imported'));
    expect(api.callsTo('POST', /^\/projects\/import$/)).toHaveLength(1);
  });

  it('manages sources through the API: add a reference, change the mode, remove', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource()] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApi(<Projects />, api);
    await user.click(await screen.findByText('Project sources (1)'));
    await user.selectOptions(screen.getByLabelText('Mode of Spec'), 'pinned');
    await waitFor(() => expect(api.state.sources[0].mode).toBe('pinned'));
    expect(api.callsTo('PATCH', /sources\/s1$/)[0].headers.get('If-Match')).toBe('"1"');

    await user.type(screen.getByLabelText('Reference name'), 'Brief');
    await user.type(screen.getByLabelText('Reference URL'), 'https://example.com/brief');
    await user.click(screen.getByRole('button', { name: 'Add reference' }));
    await waitFor(() => expect(api.state.sources.map((source) => source.name)).toContain('Brief'));
    expect(api.callsTo('POST', /sources$/)[0].body).toMatchObject({ url: 'https://example.com/brief', name: 'Brief' });

    await user.click(screen.getByRole('button', { name: 'Remove Spec' }));
    await waitFor(() => expect(api.state.sources.map((source) => source.name)).toEqual(['Brief']));
  });

  it('shows the old-data notice only when legacy data exists, and has no axe violations', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()] });
    const { container } = renderWithApi(<Projects />, api);
    await screen.findByDisplayValue('Export');
    expect(screen.queryByRole('heading', { name: 'Old local data found' })).toBeNull();
    await expectNoAxeViolations(container);
  });
});

describe('backlog items', () => {
  const setup = (itemOverrides = {}) => createFakeBacklogApi({ projects: [makeProject()], items: [makeItem(itemOverrides)] });

  it('creates an item on the server without any client-side template', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    renderWithApi(<Projects />, api);
    await user.click(await screen.findByRole('button', { name: 'Create first item' }));
    await user.type(screen.getByLabelText(/Working title/), 'Alpha work');
    await user.click(screen.getByRole('button', { name: /Create and refine/ }));
    expect(await screen.findByDisplayValue('Alpha work')).toBeInTheDocument();
    expect(api.callsTo('POST', /items$/)[0].body).toEqual({ type: 'capability', title: 'Alpha work' });
    expect(screen.getByLabelText('Document (Markdown)')).toHaveValue('# capability template');
  });

  it('autosaves edits with If-Match from the version the user saw', async () => {
    const user = userEvent.setup();
    const api = setup({ version: 4 });
    renderWithApi(<Projects />, api);
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Renamed item');
    await waitFor(() => expect(api.callsTo('PATCH', /items\/i1$/)).toHaveLength(1), { timeout: 3000 });
    const call = api.callsTo('PATCH', /items\/i1$/)[0];
    expect(call.headers.get('If-Match')).toBe('"4"');
    expect(call.body).toEqual({ title: 'Renamed item' });
    expect(api.state.items[0]).toMatchObject({ title: 'Renamed item', version: 5 });
  });

  it('opens the conflict dialog on a 409 when both sides changed the same section, and saves the resolution on top of their version', async () => {
    const user = userEvent.setup();
    const api = setup({ version: 4, document: 'mine-base' });
    renderWithApi(<Projects />, api);
    const document = await screen.findByLabelText('Document (Markdown)');
    api.state.conflictOnNextItemPatch = { item: makeItem({ version: 5, document: 'theirs', updatedBy: 'bob@example.test' }), changedSections: ['Summary'] };
    await user.type(document, '!');
    const dialog = await screen.findByRole('dialog', { name: /changed this item too/ }, { timeout: 3000 });
    await user.click(within(dialog).getByRole('radio', { name: 'Theirs' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save resolved version' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /changed this item too/ })).toBeNull());
    await waitFor(() => expect(screen.getByLabelText('Document (Markdown)')).toHaveValue('theirs'));
    expect(api.callsTo('PATCH', /items\/i1$/)).toHaveLength(1);
  });

  it('changes the status through the server (draft → refining → ready)', async () => {
    const user = userEvent.setup();
    const api = setup();
    renderWithApi(<Projects />, api);
    await user.click(await screen.findByRole('button', { name: 'Mark ready' }));
    await waitFor(() => expect(api.state.items[0].status).toBe('ready'));
    const patches = api.callsTo('PATCH', /items\/i1$/);
    expect(patches.map((call) => call.body)).toEqual([{ status: 'refining' }, { status: 'ready' }]);
    expect(patches.map((call) => call.headers.get('If-Match'))).toEqual(['"1"', '"2"']);
  });

  it('renders the backlog tree from parent ids', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ id: 'cap', type: 'capability', title: 'Parent' }), makeItem({ id: 'feat', type: 'feature', title: 'Child', parentId: 'cap' })] });
    renderWithApi(<Projects />, api);
    expect(await screen.findByText('Parent')).toBeInTheDocument();
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Parent' })).toBeEnabled();
  });

  it('deletes the item with its version after confirmation', async () => {
    const user = userEvent.setup();
    const api = setup({ version: 6 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApi(<Projects />, api);
    await screen.findByDisplayValue('Export');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Delete item/ }));
    await waitFor(() => expect(api.state.items).toHaveLength(0));
    expect(api.callsTo('DELETE', /items\/i1$/)[0].headers.get('If-Match')).toBe('"6"');
  });
});
