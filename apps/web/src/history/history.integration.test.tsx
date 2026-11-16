import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backlogKeys } from '../api';
import App from '../app/App';
import { createFakeAgentBackend } from '../test/fakeAgentBackend';
import { createFakeBacklogApi, makeItem, makeMember, makeProject } from '../test/fakeBacklogApi';
import { renderWithApi } from '../test/render';
import { makeRevision, withRevisions } from './fakeRevisions';

function setup() {
  const base = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 2, document: '## Summary\nVersion 2' })], members: [makeMember()] });
  const fake = withRevisions(base, [makeRevision(2, { actor: 'anna@example.test', origin: 'agent' }), makeRevision(1)]);
  const view = renderWithApi(<App project={makeProject()} projectBusy={false} renderProjectPanel={() => null} />, fake.api, undefined, createFakeAgentBackend().backend);
  return { ...fake, ...view };
}

describe('History tab in the item workspace', () => {
  it('replaces the old restore button, restores with If-Match and reports a conflict with the standard notice', async () => {
    const user = userEvent.setup();
    const { calls, state, api } = setup();
    await screen.findByLabelText('Document (Markdown)');
    expect(screen.queryByRole('button', { name: 'Restore previous version' })).toBeNull();
    expect(screen.queryByText('Who changed this')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('History');
    await user.click(await screen.findByRole('button', { name: /v1/ }));
    state.conflictOnRestore = true;
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));
    await user.click(screen.getByRole('button', { name: 'Restore version 1' }));
    expect(await screen.findByText(/Someone else changed this item/)).toBeInTheDocument();
    expect(calls.at(-1)?.ifMatch).toBe('"2"');

    state.conflictOnRestore = false;
    api.state.items[0].version = 2;
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));
    await user.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3));
    expect(await screen.findByText('Restored the selected version.')).toBeInTheDocument();
    expect(calls.at(-1)?.ifMatch).toBe('"2"');
  });

  it('keeps the selected tab per item and updates the timeline when new revisions arrive', async () => {
    const user = userEvent.setup();
    const { state, queryClient } = setup();
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    state.revisions = [makeRevision(3, { origin: 'agent', actor: 'anna@example.test' }), ...state.revisions];
    await queryClient.invalidateQueries({ queryKey: backlogKeys.revisions('p1', 'i1') });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Versions, newest first' })).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });
});
