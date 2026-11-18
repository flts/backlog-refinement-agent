import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useRestoreRevision } from '../api';
import { isVersionConflict } from '../api';
import { createFakeBacklogApi, makeItem, makeMember, makeProject } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi } from '../test/render';
import { useMemberDirectory } from '../collab';
import { useRevisions } from '../api';
import { HistoryPanel } from './HistoryPanel';
import { makeRevision, withRevisions } from './fakeRevisions';
import { formatRelative } from './time';

const current = { id: 'i1', title: 'Export', document: '## Summary\nVersion 3\nUnsaved line' };
const threeRevisions = () => [
  makeRevision(3, { actor: 'anna@example.test', origin: 'agent', label: 'Agent refinement', document: '## Summary\nVersion 3' }),
  makeRevision(2, { origin: 'restore' }),
  makeRevision(1),
];

/** Wires the panel like App does: revisions query, member names, restore mutation, and a reported outcome. */
function Connected({ item = current, onResult = vi.fn() }: { item?: typeof current; onResult?: (ok: boolean, error?: unknown) => void }) {
  const revisions = useRevisions('p1', 'i1');
  const { nameOf } = useMemberDirectory('p1');
  const restore = useRestoreRevision('p1');
  return <HistoryPanel projectId="p1" item={item} revisions={revisions.data ?? []} loading={revisions.isLoading} nameOf={nameOf}
    onRestore={async (revisionId) => {
      try { await restore.mutateAsync({ item: { id: 'i1', version: 3 }, revisionId }); onResult(true); return true; }
      catch (error) { onResult(false, error); return false; }
    }} />;
}

function setup(revisions = threeRevisions(), onResult = vi.fn()) {
  const base = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: revisions.length, document: current.document })], members: [makeMember({ email: 'anna@example.test', name: 'Anna Jansen' }), makeMember()] });
  const fake = withRevisions(base, revisions);
  const view = renderWithApi(<Connected onResult={onResult} />, fake.api);
  return { ...fake, ...view, onResult };
}

describe('HistoryPanel', () => {
  it('lists versions newest first with author, origin badge, label and a tooltip time', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Versions, newest first' });
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent('v3');
    expect(entries[0]).toHaveTextContent('Anna Jansen');
    expect(entries[0]).toHaveTextContent('Via agent');
    expect(entries[0]).toHaveTextContent('Agent refinement');
    expect(entries[0]).toHaveTextContent('Current');
    expect(entries[1]).toHaveTextContent('Restored');
    expect(entries[2]).toHaveTextContent('Alice Owner');
    expect(entries[2]).toHaveTextContent('Edited');
    const time = entries[2].querySelector('time')!;
    expect(time).toHaveAttribute('dateTime', '2026-01-01T10:00:00.000Z');
    expect(time.getAttribute('title')).toBeTruthy();
  });

  it('shows a selected version and compares it with the current and the previous version', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: /v2/ }));
    const detail = await screen.findByRole('region', { name: 'Version 2' });
    expect(await within(detail).findByLabelText('Document of version 2')).toHaveTextContent('Version 2');
    await user.click(within(detail).getByRole('radio', { name: 'Compare with current' }));
    const diff = await within(detail).findByRole('group', { name: 'Changes from Version 2 to Current version' });
    expect(diff).toHaveTextContent('Version 2');
    expect(diff).toHaveTextContent('Unsaved line');
    await user.click(within(detail).getByRole('radio', { name: 'Compare with previous' }));
    expect(await within(detail).findByRole('group', { name: 'Changes from Version 1 to Version 2' })).toBeInTheDocument();
  });

  it('reports identical content when comparing with the current version', async () => {
    const user = userEvent.setup();
    const base = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 1 })], members: [makeMember()] });
    const fake = withRevisions(base, threeRevisions());
    renderWithApi(<Connected item={{ ...current, document: '## Summary\nVersion 2' }} />, fake.api);
    await user.click(await screen.findByRole('button', { name: /v2/ }));
    await user.click(await screen.findByRole('radio', { name: 'Compare with current' }));
    expect(await screen.findByText('Current version is identical to Version 2.')).toBeInTheDocument();
  });

  it('cannot compare the oldest version with a previous one and cannot restore the current one', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    expect(screen.getByRole('radio', { name: 'Compare with previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /v3/ }));
    expect(screen.getByText('This is the current version.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
  });

  it('restores a version after confirmation, sending If-Match, and picks up the new revision', async () => {
    const user = userEvent.setup();
    const { calls, onResult } = setup();
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/Restore version 1 as a new version/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(calls).toEqual([{ path: '/projects/p1/items/i1/revisions/r1/restore', ifMatch: '"3"' }]);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4));
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Restored');
  });

  it('lets the user cancel a restore', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('surfaces a version conflict from the restore to the caller', async () => {
    const user = userEvent.setup();
    const { state, onResult } = setup();
    state.conflictOnRestore = true;
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));
    await user.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const [ok, error] = onResult.mock.calls[0];
    expect(ok).toBe(false);
    expect(isVersionConflict(error)).toBe(true);
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeInTheDocument();
  });

  it('explains the empty and single-version states', async () => {
    const empty = setup([]);
    expect(await screen.findByText(/No saved versions yet/)).toBeInTheDocument();
    empty.unmount();
    setup([makeRevision(1)]);
    expect(await screen.findByText(/Only one version so far/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it.each(['light', 'dark'])('has no axe violations in the %s theme', async (theme) => {
    document.documentElement.dataset.theme = theme;
    const user = userEvent.setup();
    const { container } = setup();
    await user.click(await screen.findByRole('button', { name: /v2/ }));
    await user.click(await screen.findByRole('radio', { name: 'Compare with current' }));
    await screen.findByRole('group', { name: /Changes from Version 2/ });
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));
    await expectNoAxeViolations(container);
    delete document.documentElement.dataset.theme;
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  it('describes recent and older times', () => {
    expect(formatRelative('2026-03-10T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-03-10T10:00:00Z', now)).toBe('2 hours ago');
    expect(formatRelative('2026-03-09T11:00:00Z', now)).toBe('yesterday');
  });
});

