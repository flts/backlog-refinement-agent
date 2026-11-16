import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useItem } from '../api';
import { createFakeBacklogApi, makeItem, makeProject } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi } from '../test/render';
import { ConflictDialog } from './ConflictDialog';
import { planMerge } from './merge';
import { autosaveDelayMs, useItemAutosave } from './useItemAutosave';
import type { Notifications } from '../app/useNotifications';

const notifications = () => ({ setNotice: vi.fn(), report: vi.fn() }) as unknown as Pick<Notifications, 'setNotice' | 'report'> & { setNotice: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn> };

function Editor({ notes }: { notes: ReturnType<typeof notifications> }) {
  const item = useItem('p1', 'i1').data;
  const autosave = useItemAutosave('p1', notes, () => 'Bob');
  const conflict = autosave.openConflict('i1');
  const [busy] = useState(false);
  if (!item) return null;
  const draft = autosave.drafts[item.id];
  return <div>
    <label>Doc<textarea value={draft?.document ?? item.document} onChange={(event) => autosave.edit(item, { document: event.target.value })} /></label>
    <label>Name<input value={draft?.title ?? item.title} onChange={(event) => autosave.edit(item, { title: event.target.value })} /></label>
    <output data-testid="status">{autosave.status}</output>
    <output data-testid="server">{item.document}</output>
    {conflict && <ConflictDialog plan={conflict.plan} theirAuthor="Bob" busy={busy} onResolve={(merged) => void autosave.resolveConflict('i1', merged)} onClose={() => autosave.postponeConflict('i1')} />}
  </div>;
}

describe('item autosave', () => {
  afterEach(() => vi.useRealTimers());

  it('debounces edits by one second and sends one PATCH with If-Match of the version the user started from', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 4, document: '## A\none' })] });
    renderWithApi(<Editor notes={notifications()} />, api);
    const field = await screen.findByLabelText('Doc');
    fireEvent.change(field, { target: { value: '## A\ntwo' } });
    expect(screen.getByTestId('status')).toHaveTextContent('saving');
    await act(async () => { await vi.advanceTimersByTimeAsync(autosaveDelayMs - 100); });
    fireEvent.change(field, { target: { value: '## A\ntwo!' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(autosaveDelayMs - 100); });
    expect(api.callsTo('PATCH', /items\/i1$/)).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await waitFor(() => expect(api.callsTo('PATCH', /items\/i1$/)).toHaveLength(1));
    const call = api.callsTo('PATCH', /items\/i1$/)[0];
    expect(call.headers.get('If-Match')).toBe('"4"');
    expect(call.body).toEqual({ document: '## A\ntwo!' });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('saved'));
  });

  it('merges non-overlapping changes of both sides without asking', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 4, document: '## A\none\n\n## B\nbee' })] });
    const notes = notifications();
    renderWithApi(<Editor notes={notes} />, api);
    const field = await screen.findByLabelText('Doc');
    api.state.conflictOnNextItemPatch = { item: makeItem({ version: 5, document: '## A\none\n\n## B\ntheirs-bee', updatedBy: 'bob@example.test' }) };
    fireEvent.change(field, { target: { value: '## A\none!\n\n## B\nbee' } });
    await waitFor(() => expect(api.callsTo('PATCH', /items\/i1$/)).toHaveLength(2), { timeout: 4000 });
    expect(api.callsTo('PATCH', /items\/i1$/)[1].headers.get('If-Match')).toBe('"5"');
    expect(api.state.items[0].document).toBe('## A\none!\n\n## B\ntheirs-bee');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(notes.setNotice).toHaveBeenCalledWith('Merged your changes with the changes by Bob.');
  });

  async function conflict(choice: 'Mine' | 'Theirs' | 'Both') {
    const user = userEvent.setup();
    const base = '## A\nbase\n\n## B\nbee';
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 4, document: base })] });
    const notes = notifications();
    renderWithApi(<Editor notes={notes} />, api);
    const field = await screen.findByLabelText('Doc');
    api.state.conflictOnNextItemPatch = { item: makeItem({ version: 5, document: '## A\ntheirs\n\n## B\ntheirs-bee', updatedBy: 'bob@example.test' }) };
    fireEvent.change(field, { target: { value: '## A\nmine\n\n## B\nbee' } });
    const dialog = await screen.findByRole('dialog', { name: 'Bob changed this item too' }, { timeout: 4000 });
    expect(screen.getByTestId('status')).toHaveTextContent('conflict');
    // Only section A needs a choice; B was changed by them alone.
    expect(within(dialog).getAllByRole('radiogroup')).toHaveLength(1);
    expect(within(dialog).getByRole('radiogroup', { name: 'Keep which version of A?' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Mine' })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: choice }));
    await user.click(within(dialog).getByRole('button', { name: 'Save resolved version' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const patches = api.callsTo('PATCH', /items\/i1$/);
    // Choosing everything of theirs leaves nothing to send.
    expect(patches).toHaveLength(choice === 'Theirs' ? 1 : 2);
    if (choice !== 'Theirs') expect(patches[1].headers.get('If-Match')).toBe('"5"');
    expect(notes.setNotice).toHaveBeenCalledWith('Conflict resolved and saved.');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('saved'));
    return api.state.items[0].document;
  }

  it('conflict dialog: Mine keeps my section and their other changes', async () => { expect(await conflict('Mine')).toBe('## A\nmine\n\n## B\ntheirs-bee'); });
  it('conflict dialog: Theirs takes their section', async () => { expect(await conflict('Theirs')).toBe('## A\ntheirs\n\n## B\ntheirs-bee'); });
  it('conflict dialog: Both concatenates mine, then theirs', async () => { expect(await conflict('Both')).toBe('## A\nmine\n\ntheirs\n\n## B\ntheirs-bee'); });

  it('lets the user decide later: the dialog closes, the edits stay unsaved and no PATCH is sent', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 4, document: '## A\nbase' })] });
    renderWithApi(<Editor notes={notifications()} />, api);
    const field = await screen.findByLabelText('Doc');
    api.state.conflictOnNextItemPatch = { item: makeItem({ version: 5, document: '## A\ntheirs', updatedBy: 'bob@example.test' }) };
    fireEvent.change(field, { target: { value: '## A\nmine' } });
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 4000 });
    await user.click(within(dialog).getAllByRole('button', { name: 'Decide later' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByLabelText('Doc')).toHaveValue('## A\nmine');
    expect(screen.getByTestId('status')).toHaveTextContent('conflict');
    expect(api.callsTo('PATCH', /items\/i1$/)).toHaveLength(1);
  });
});

describe('ConflictDialog', () => {
  const plan = planMerge(
    { title: 'T', document: '## A\nbase\n\n## B\nbase' },
    { title: 'Mine', document: '## A\nmine\n\n## B\nmine' },
    { title: 'Theirs', document: '## A\ntheirs\n\n## B\ntheirs' },
  );

  it('asks per section and for the title, is labelled and passes axe', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const { container } = renderWithApi(<ConflictDialog plan={plan} theirAuthor="Bob" onResolve={onResolve} onClose={vi.fn()} />, createFakeBacklogApi());
    const dialog = screen.getByRole('dialog', { name: 'Bob changed this item too' });
    expect(within(dialog).getAllByRole('radiogroup').map((group) => group.getAttribute('aria-label'))).toEqual(['Keep which title?', 'Keep which version of A?', 'Keep which version of B?']);
    await expectNoAxeViolations(container);
    const groups = within(dialog).getAllByRole('radiogroup');
    await user.click(within(groups[0]).getByRole('radio', { name: 'Theirs' }));
    await user.click(within(groups[1]).getByRole('radio', { name: 'Both' }));
    await user.click(within(groups[2]).getByRole('radio', { name: 'Theirs' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save resolved version' }));
    expect(onResolve).toHaveBeenCalledWith({ title: 'Theirs', document: '## A\nmine\n\ntheirs\n\n## B\ntheirs' });
  });
});
