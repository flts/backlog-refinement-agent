import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBacklogApi, makeMember, makeProject } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi } from '../test/render';
import { ShareDialog } from './ShareDialog';

afterEach(() => vi.restoreAllMocks());

const alice = makeMember();
const bob = makeMember({ email: 'bob@example.test', name: 'Bob Builder', role: 'contributor' });
const carol = makeMember({ email: 'carol@example.test', name: null, signedIn: false, role: 'contributor' });

function setup(members = [alice, bob, carol], role: 'owner' | 'contributor' = 'owner', extra: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  const project = makeProject({ role });
  const api = createFakeBacklogApi({ projects: [project], members: members.map((member) => ({ ...member })) });
  const onClose = vi.fn();
  const view = renderWithApi(<ShareDialog project={project} onClose={onClose} {...extra} />, api);
  return { api, onClose, ...view };
}

describe('ShareDialog', () => {
  it('lists members with email, display name and a "not signed in yet" hint, and passes axe', async () => {
    const { container } = setup();
    const list = await screen.findByRole('list', { name: 'Project members' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(within(list).getByText('Bob Builder')).toBeInTheDocument();
    expect(within(list).getByText('bob@example.test')).toBeInTheDocument();
    expect(within(list).getByText('carol@example.test')).toBeInTheDocument();
    expect(within(list).getByText('Not signed in yet')).toBeInTheDocument();
    expect(within(list).getByText('(you)')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('adds a member by email with a role, immediately, and validates the address', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const input = await screen.findByLabelText('Add by email address');
    await user.type(input, 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/Enter a complete email address/)).toBeInTheDocument();
    expect(api.callsTo('POST', /members$/)).toHaveLength(0);

    await user.clear(input);
    await user.type(input, 'dave@example.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'owner');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.callsTo('POST', /members$/)).toHaveLength(1));
    expect(api.callsTo('POST', /members$/)[0].body).toEqual({ email: 'dave@example.test', role: 'owner' });
    expect(await screen.findByRole('combobox', { name: 'Role of dave@example.test' })).toHaveValue('owner');
    expect(input).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('dave@example.test now has access as owner.');
  });

  it('rejects an address that is already a member', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.type(await screen.findByLabelText('Add by email address'), 'BOB@example.test');
    await screen.findByText('Bob Builder');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('This email address is already a member of the project.')).toBeInTheDocument();
    expect(api.callsTo('POST', /members$/)).toHaveLength(0);
  });

  it('changes a role', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role of bob@example.test' }), 'owner');
    await waitFor(() => expect(api.callsTo('PATCH', /members\/bob/)).toHaveLength(1));
    expect(api.callsTo('PATCH', /members\/bob/)[0].body).toEqual({ role: 'owner' });
    expect(await screen.findByRole('status')).toHaveTextContent('bob@example.test is now owner.');
  });

  it('removes a member after confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { api } = setup();
    const remove = await screen.findByRole('button', { name: 'Remove bob@example.test' });
    await user.click(remove);
    expect(api.callsTo('DELETE', /members/)).toHaveLength(0);
    await user.click(remove);
    await waitFor(() => expect(screen.queryByText('Bob Builder')).toBeNull());
    expect(api.callsTo('DELETE', /members\/bob/)).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Remove alice@example.test' })).toBeNull();
  });

  it('disables demote and leave for the last owner and explains why', async () => {
    setup([alice, bob]);
    const role = await screen.findByRole('combobox', { name: 'Role of alice@example.test' });
    expect(role).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Leave project' })).toBeDisabled();
    expect(screen.getByText(/Last owner: A project needs at least one owner/)).toBeInTheDocument();
    expect(role).toHaveAccessibleDescription(/at least one owner/);
  });

  it('shows the last-owner explanation when the server answers 409 last-owner', async () => {
    const user = userEvent.setup();
    const { api } = setup([alice, makeMember({ email: 'bob@example.test', name: 'Bob', role: 'owner' })]);
    const select = await screen.findByRole('combobox', { name: 'Role of bob@example.test' });
    // Another owner removed Bob's co-owner in the meantime: the client still thinks there are two owners.
    api.state.members = [api.state.members[1]];
    await user.selectOptions(select, 'contributor');
    expect(await screen.findByRole('alert')).toHaveTextContent('A project needs at least one owner. Make someone else an owner first.');
  });

  it('lets the signed-in user leave when there is another owner', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onLeft = vi.fn();
    const { api, onClose } = setup([alice, makeMember({ email: 'bob@example.test', name: 'Bob', role: 'owner' })], 'owner', { onLeft });
    await user.click(await screen.findByRole('button', { name: 'Leave project' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(api.callsTo('DELETE', /members\/alice/)).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('is a read-only list for contributors who may still leave', async () => {
    const { container } = setup([makeMember({ role: 'contributor' }), makeMember({ email: 'bob@example.test', name: 'Bob', role: 'owner' })], 'contributor');
    await screen.findByText('Bob');
    expect(screen.queryByLabelText('Add by email address')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave project' })).toBeEnabled();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('closes with Escape', async () => {
    const { onClose } = setup();
    await screen.findByText('Bob Builder');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
