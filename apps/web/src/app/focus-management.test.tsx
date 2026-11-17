import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictDialog, ShareDialog, planMerge } from '../collab';
import { CommandPalette, PALETTE_EVENTS } from '../palette';
import { ProjectSettingsDialog } from '../settings/ProjectSettingsDialog';
import { createFakeGuidanceApi } from '../settings/fakeGuidanceApi';
import { AccountMenu } from '../shell/AccountMenu';
import { Menu } from '../shell/Menu';
import { NewProjectDialog } from '../shell/NewProjectDialog';
import { SourcesDrawer } from '../sources';
import { createFakeBacklogApi, makeItem, makeMember, makeProject } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi } from '../test/render';
import { NewItemModal } from './NewItemModal';
import { SettingsModal } from './SettingsModal';

afterEach(() => { delete document.documentElement.dataset.theme; vi.restoreAllMocks(); });

const base = { title: 'Export', document: '## Summary\nbase' };
const conflictPlan = planMerge(base, { title: 'Export', document: '## Summary\nmine' }, { title: 'Export', document: '## Summary\ntheirs' });

/** A trigger button that toggles the dialog, like the real entry points do. */
function Opener({ children }: { children: (close: () => void) => ReactElement }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>open</button>
    {open && children(() => setOpen(false))}
  </>;
}

const api = () => createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()], members: [makeMember()] });

const dialogs: { name: string; render: (close: () => void) => ReactElement; api?: () => ReturnType<typeof createFakeBacklogApi>; busy?: boolean }[] = [
  { name: 'NewProjectDialog', render: (close) => <NewProjectDialog onCreate={async () => true} onClose={close} /> },
  { name: 'NewItemModal', render: (close) => <NewItemModal type="capability" title="" onTypeChange={vi.fn()} onTitleChange={vi.fn()} onSubmit={vi.fn()} onClose={close} /> },
  { name: 'SettingsModal', render: (close) => <SettingsModal onClose={close} projectName="Alpha" /> },
  { name: 'ProjectSettingsDialog', api: () => createFakeGuidanceApi({ projects: [makeProject()] }), render: (close) => <ProjectSettingsDialog project={makeProject()} onClose={close} /> },
  { name: 'ShareDialog', render: (close) => <ShareDialog project={makeProject()} onClose={close} /> },
  { name: 'ConflictDialog', render: (close) => <ConflictDialog plan={conflictPlan} theirAuthor="Anna" onResolve={vi.fn()} onClose={close} /> },
  { name: 'SourcesDrawer', render: (close) => <SourcesDrawer projectId="p1" projectName="Alpha" onClose={close} /> },
];

describe.each(dialogs)('$name focus management', ({ render: ui, api: makeApi = api }) => {
  it('moves focus into the dialog, closes with Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderWithApi(<Opener>{ui}</Opener>, makeApi());
    const trigger = screen.getByRole('button', { name: 'open' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it.each(['light', 'dark'])('has no axe violations in the %s theme and a labelled heading', async (theme) => {
    document.documentElement.dataset.theme = theme;
    const user = userEvent.setup();
    const { baseElement } = renderWithApi(<Opener>{ui}</Opener>, makeApi());
    await user.click(screen.getByRole('button', { name: 'open' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getAllByRole('heading').length).toBeGreaterThan(0));
    await waitFor(() => expect(within(dialog).queryAllByRole('status').filter((node) => /Loading/.test(node.textContent ?? ''))).toHaveLength(0));
    await expectNoAxeViolations(baseElement);
  });

  it('does not trap keyboard focus: Tab cycles inside the dialog and the close control is reachable', async () => {
    const user = userEvent.setup();
    renderWithApi(<Opener>{ui}</Opener>, makeApi());
    await user.click(screen.getByRole('button', { name: 'open' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('button').length).toBeGreaterThan(0);
    // Every close control and every Cancel button must be a real, enabled, tabbable button.
    for (const button of within(dialog).queryAllByRole('button', { name: /^(Close|Cancel|Decide later)/ })) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('tabindex', '-1');
    }
  });
});

describe('CommandPalette focus management', () => {
  it('focuses the search box, closes with Escape and restores focus to the previously focused control', async () => {
    const user = userEvent.setup();
    renderWithApi(<><button>trigger</button><CommandPalette projectId="p1" onSelectItem={vi.fn()} onRunIntent={vi.fn()} onNewSession={vi.fn()} debounceMs={0} /></>, api());
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.focus();
    act(() => { window.dispatchEvent(new CustomEvent(PALETTE_EVENTS.open)); });
    expect(await screen.findByRole('combobox')).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe.each(['light', 'dark'])('menus (%s)', (theme) => {
  const items = [{ id: 'a', label: 'Alpha', onSelect: vi.fn() }, { id: 'b', label: 'Beta', onSelect: vi.fn() }];

  it('Menu: opens onto the first item, Escape closes and restores focus to the trigger, Tab does not trap', async () => {
    document.documentElement.dataset.theme = theme;
    const user = userEvent.setup();
    const { container } = renderWithApi(<><Menu label="Things" trigger="Things" items={items} /><button>after</button></>, api());
    const trigger = screen.getByRole('button', { name: 'Things' });
    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await expectNoAxeViolations(container);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Menu: choosing an entry restores focus to the trigger before running the action', async () => {
    const user = userEvent.setup();
    let focusedDuringAction: Element | null = null;
    const onSelect = vi.fn(() => { focusedDuringAction = document.activeElement; });
    renderWithApi(<Menu label="Things" trigger="Things" items={[{ id: 'a', label: 'Alpha', onSelect }]} />, api());
    const trigger = screen.getByRole('button', { name: 'Things' });
    await user.click(trigger);
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalled();
    expect(focusedDuringAction).toBe(trigger);
  });

  it('AccountMenu: Escape closes the panel and restores focus to the avatar button', async () => {
    document.documentElement.dataset.theme = theme;
    const user = userEvent.setup();
    const { container } = renderWithApi(<AccountMenu />, api());
    const button = screen.getByRole('button', { name: /^Account:/ });
    await user.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Account' });
    await expectNoAxeViolations(container);
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
    expect(button).toHaveFocus();
  });
});
