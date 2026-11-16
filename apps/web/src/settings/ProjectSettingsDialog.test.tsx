import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { applyTheme } from '../app/theme';
import { makeProject } from '../test/fakeBacklogApi';
import { renderWithApi } from '../test/render';
import { expectNoAxeViolations } from '../test/axe';
import { createFakeGuidanceApi } from './fakeGuidanceApi';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';

afterEach(() => { vi.restoreAllMocks(); applyTheme('system'); });

const project = makeProject({ id: 'p1', name: 'Alpha', version: 4 });

function setup(options: { role?: 'owner' | 'contributor'; onClose?: () => void; onOpenShare?: () => void; seed?: (api: ReturnType<typeof createFakeGuidanceApi>) => void } = {}) {
  const api = createFakeGuidanceApi({ projects: [{ ...project, role: options.role ?? 'owner' }] });
  options.seed?.(api);
  const view = renderWithApi(<ProjectSettingsDialog project={api.state.projects[0]} onClose={options.onClose ?? vi.fn()} onOpenShare={options.onOpenShare} />, api);
  return { api, user: userEvent.setup(), ...view };
}

async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));
}

describe('project settings: guidance editing (owner)', () => {
  it('saves the first override with If-Match 0 and the next with the row version', async () => {
    const { api, user } = setup();
    await openTab(user, 'Agent principles');
    const box = await screen.findByRole('textbox', { name: 'Agent principles' });
    expect(box).toHaveValue('Default principles');
    expect(screen.getByText('Skill default v1.0.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'My principles' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Project override')).toBeInTheDocument());
    const first = api.guidanceCalls.find((call) => call.method === 'PUT')!;
    expect(first.ifMatch).toBe('"0"');
    expect(first.body).toEqual({ content: 'My principles', baseSkillVersion: '1.0.0' });
    expect(await screen.findByText('Differs from skill default v1.0.0')).toBeInTheDocument();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'My principles v2' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.guidanceCalls.filter((call) => call.method === 'PUT')).toHaveLength(2));
    expect(api.guidanceCalls.filter((call) => call.method === 'PUT')[1].ifMatch).toBe('"1"');
  });

  it('edits templates and type instructions per item type', async () => {
    const { api, user } = setup();
    await openTab(user, 'Feature');
    expect(await screen.findByRole('textbox', { name: 'Feature template' })).toHaveValue('## Summary\n\nDefault feature template');
    fireEvent.change(screen.getByRole('textbox', { name: 'Feature instructions' }), { target: { value: 'Be brief' } });
    const section = screen.getByRole('textbox', { name: 'Feature instructions' }).closest('section')!;
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.overrides['type-instructions:feature']).toBeDefined());
    expect(api.guidanceCalls.find((call) => call.method === 'PUT')!.path).toBe('/projects/p1/guidance/type-instructions/feature');
  });

  it('resets an override to the skill default after confirmation', async () => {
    const { api, user } = setup({ seed: (fake) => fake.setOverride('principles', 'Custom') });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await openTab(user, 'Agent principles');
    expect(await screen.findByRole('textbox', { name: 'Agent principles' })).toHaveValue('Custom');
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(api.guidanceCalls.some((call) => call.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Agent principles' })).toHaveValue('Default principles'));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.guidanceCalls.find((call) => call.method === 'DELETE')!.ifMatch).toBe('"1"');
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('compares the effective text with the skill default as an accessible diff', async () => {
    const { user, container } = setup({ seed: (fake) => fake.setOverride('principles', 'Default principles\nExtra rule') });
    await openTab(user, 'Agent principles');
    await user.click(await screen.findByRole('button', { name: 'Compare with default' }));
    const diff = screen.getByRole('group', { name: /Changes from skill default v1.0.0/ });
    expect(within(diff).getByText('Added:')).toBeInTheDocument();
    expect(diff).toHaveTextContent('Extra rule');
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Hide comparison' }));
    expect(screen.queryByRole('group', { name: /Changes from/ })).toBeNull();
  });

  it('says so when the override equals the default text', async () => {
    const { user } = setup();
    await openTab(user, 'Agent principles');
    await user.click(await screen.findByRole('button', { name: 'Compare with default' }));
    expect(screen.getByText(/is identical to skill default v1.0.0/)).toBeInTheDocument();
  });

  it('flags an outdated override with the skill version it is based on', async () => {
    const { user } = setup({ seed: (fake) => fake.setOverride('principles', 'Old custom', '0.9.0') });
    await openTab(user, 'Agent principles');
    expect(await screen.findByText('Outdated: based on v0.9.0')).toBeInTheDocument();
    expect(screen.getByText('Differs from skill default v1.0.0')).toBeInTheDocument();
  });

  it('warns about {{…}} placeholders in templates and shows the server issues inline', async () => {
    const { user } = setup();
    await openTab(user, 'Capability');
    const box = await screen.findByRole('textbox', { name: 'Capability template' });
    fireEvent.change(box, { target: { value: '## A\n{{name}}' } });
    expect(screen.getByText(/Line 2 contains a/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled();
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the 422 issues returned by the server inline and keeps the draft', async () => {
    const { api, user } = setup();
    api.control.rejectNext = ["Line 3 contains a '{{…}}' placeholder; templates must be placeholder-free Markdown.", 'Content must not be empty.'];
    await openTab(user, 'Capability');
    const box = await screen.findByRole('textbox', { name: 'Capability template' });
    fireEvent.change(box, { target: { value: 'edited' } });
    await user.click(within(box.closest('section')!).getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);
    expect(alert).toHaveTextContent('Line 3 contains a');
    expect(box).toHaveValue('edited');
  });

  it('tells about a version conflict and reloads the other version', async () => {
    const { api, user } = setup();
    await openTab(user, 'Agent principles');
    const box = await screen.findByRole('textbox', { name: 'Agent principles' });
    fireEvent.change(box, { target: { value: 'Mine' } });
    api.setOverride('principles', 'Theirs', '1.0.0', 5);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Someone else changed this guidance.');
    await user.click(within(alert).getByRole('button', { name: 'Reload their version' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Agent principles' })).toHaveValue('Theirs'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps my text after a conflict and saves with the new version', async () => {
    const { api, user } = setup();
    await openTab(user, 'Agent principles');
    const box = await screen.findByRole('textbox', { name: 'Agent principles' });
    fireEvent.change(box, { target: { value: 'Mine' } });
    api.setOverride('principles', 'Theirs', '1.0.0', 5);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Keep my text' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.overrides.principles.content).toBe('Mine'));
    expect(api.guidanceCalls.filter((call) => call.method === 'PUT').at(-1)!.ifMatch).toBe('"5"');
  });
});

describe('project settings: unsaved changes guard', () => {
  it('asks before switching sections or closing, and discards on confirm', async () => {
    const onClose = vi.fn();
    const { user } = setup({ onClose });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);
    await openTab(user, 'Agent principles');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Agent principles' }), { target: { value: 'edited' } });
    expect(screen.getByRole('tab', { name: /Agent principles/ })).toHaveTextContent('unsaved changes');

    await openTab(user, 'General');
    expect(screen.getByRole('tab', { name: /Agent principles/ })).toHaveAttribute('aria-selected', 'true');
    await openTab(user, 'General');
    expect(screen.getByRole('tab', { name: /General/ })).toHaveAttribute('aria-selected', 'true');
    await openTab(user, 'Agent principles');
    expect(screen.getByRole('textbox', { name: 'Agent principles' })).toHaveValue('Default principles');

    fireEvent.change(screen.getByRole('textbox', { name: 'Agent principles' }), { target: { value: 'again' } });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(4);
  });

  it('closes without a prompt when nothing changed', async () => {
    const onClose = vi.fn();
    const { user } = setup({ onClose });
    const confirm = vi.spyOn(window, 'confirm');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('project settings: contributors', () => {
  it('shows everything read-only with an explanation and no destructive actions', async () => {
    const { user, api } = setup({ role: 'contributor', seed: (fake) => fake.setOverride('principles', 'Custom') });
    expect(screen.getByText(/Only project owners can change project settings/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveAttribute('readonly');
    for (const name of ['Rename', 'Delete project']) expect(screen.queryByRole('button', { name })).toBeNull();
    await openTab(user, 'Agent principles');
    const box = await screen.findByRole('textbox', { name: 'Agent principles' });
    expect(box).toHaveAttribute('readonly');
    expect(box).toHaveValue('Custom');
    for (const name of ['Save', 'Reset to default']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('button', { name: 'Compare with default' })).toBeEnabled();
    await openTab(user, 'Import / Export');
    expect(screen.getByRole('button', { name: 'Export guidance' })).toBeInTheDocument();
    for (const name of ['Import guidance', 'Export project backup']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(api.guidanceCalls.some((call) => ['PUT', 'DELETE', 'POST'].includes(call.method))).toBe(false);
  });
});

describe('project settings: general and members', () => {
  it('renames with If-Match and reports a conflict', async () => {
    const { api, user } = setup();
    const input = screen.getByRole('textbox', { name: 'Project name' });
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Beta');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(api.state.projects[0].name).toBe('Beta'));
    expect(api.callsTo('PATCH', /^\/projects\/p1$/)[0].headers.get('If-Match')).toBe('"4"');
    expect(await screen.findByText('Project renamed.')).toBeInTheDocument();

    api.state.projects[0].version = 12;
    await user.clear(input);
    await user.type(input, 'Gamma');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this project.');
  });

  it('deletes only after typing the project name', async () => {
    const onClose = vi.fn();
    const { api, user } = setup({ onClose });
    const button = screen.getByRole('button', { name: 'Delete project' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'Alph');
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Type the project name to confirm'), 'a');
    await user.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.callsTo('DELETE', /^\/projects\/p1$/)).toHaveLength(1);
    expect(api.callsTo('DELETE', /^\/projects\/p1$/)[0].headers.get('If-Match')).toBe('"4"');
  });

  it('lists members read-only and opens the share dialog through onOpenShare', async () => {
    const onOpenShare = vi.fn();
    const { user } = setup({ onOpenShare });
    await openTab(user, 'Members');
    expect(await screen.findByRole('list', { name: 'Project members' })).toHaveTextContent('Alice Owner');
    await user.click(screen.getByRole('button', { name: 'Manage members' }));
    expect(onOpenShare).toHaveBeenCalledOnce();
  });

  it('does not offer member management to contributors', async () => {
    const { user } = setup({ role: 'contributor', onOpenShare: vi.fn() });
    await openTab(user, 'Members');
    await screen.findByRole('list', { name: 'Project members' });
    expect(screen.queryByRole('button', { name: 'Manage members' })).toBeNull();
  });
});

describe('project settings: import / export', () => {
  function stubDownload() {
    const click = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    return click;
  }

  it('exports the guidance (v5) and the project backup', async () => {
    const download = stubDownload();
    const { api, user } = setup({ seed: (fake) => fake.setOverride('principles', 'Custom') });
    await openTab(user, 'Import / Export');
    await user.click(screen.getByRole('button', { name: 'Export guidance' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(api.guidanceCalls.find((call) => call.path === '/projects/p1/guidance/export')).toBeDefined();
    expect(await screen.findByText('Guidance exported (format v5).')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Include skill defaults/ }));
    await user.click(screen.getByRole('button', { name: 'Export guidance' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Export project backup' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(3));
    expect(api.callsTo('GET', /^\/projects\/p1\/backup$/)).toHaveLength(1);
  });

  it('imports a v5 guidance file after confirmation and refreshes the editors', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, user, container } = setup();
    await openTab(user, 'Import / Export');
    const file = new File([JSON.stringify({ format: 'backlog-guidance', formatVersion: 5, guidance: { templates: { feature: { content: 'Imported template', baseSkillVersion: '1.0.0' } } } })], 'g.json', { type: 'application/json' });
    fireEvent.change(container.ownerDocument.querySelector('input[type=file]')!, { target: { files: [file] } });
    expect(await screen.findByText('Guidance imported from g.json.')).toBeInTheDocument();
    expect(api.overrides['template:feature'].content).toBe('Imported template');
    await openTab(user, 'Feature');
    expect(await screen.findByRole('textbox', { name: 'Feature template' })).toHaveValue('Imported template');
  });

  it('lists the validation issues of a rejected import and keeps the current guidance', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, user, container } = setup();
    await openTab(user, 'Import / Export');
    const file = new File([JSON.stringify({ format: 'backlog-guidance', formatVersion: 5, guidance: { templates: { feature: { content: '{{x}}' }, enabler: { content: '{{y}}' } } } })], 'bad.json');
    fireEvent.change(container.ownerDocument.querySelector('input[type=file]')!, { target: { files: [file] } });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);
    expect(alert).toHaveTextContent('templates.feature');
    expect(Object.keys(api.overrides)).toHaveLength(0);
  });

  it('rejects files that are not JSON before calling the server', async () => {
    const { api, user, container } = setup();
    await openTab(user, 'Import / Export');
    fireEvent.change(container.ownerDocument.querySelector('input[type=file]')!, { target: { files: [new File(['nope'], 'x.json')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON');
    expect(api.guidanceCalls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('project settings: accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    applyTheme(theme);
    const { user, container } = setup({ seed: (fake) => fake.setOverride('principles', 'Custom', '0.9.0') });
    expect(screen.getByRole('dialog', { name: 'Project settings' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await openTab(user, 'Agent principles');
    await screen.findByRole('textbox', { name: 'Agent principles' });
    await expectNoAxeViolations(container);
    await openTab(user, 'Feature');
    await screen.findByRole('textbox', { name: 'Feature template' });
    await expectNoAxeViolations(container);
  });

  it('moves between sections with the arrow keys', async () => {
    const { user } = setup();
    screen.getByRole('tab', { name: /General/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: /Members/ })).toHaveFocus();
    expect(screen.getByRole('tab', { name: /Members/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Import/ })).toHaveFocus();
  });
});
