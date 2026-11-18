import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../chat';
import { expectNoAxeViolations } from '../test/axe';
import { createFakeBacklogApi, makeItem } from '../test/fakeBacklogApi';
import { renderWithApi } from '../test/render';
import { CommandPalette, PALETTE_EVENTS, agentCommandsFor, type CommandPaletteProps } from '.';
import { withExtras, type TestExtras } from './testApi';

const items = [
  makeItem({ id: 'i1', type: 'capability', title: 'Billing overhaul' }),
  makeItem({ id: 'i2', type: 'feature', title: 'Invoice export', parentId: 'i1' }),
  makeItem({ id: 'i3', type: 'enabler', title: 'Queue upgrade' }),
];

function setup(overrides: Partial<CommandPaletteProps> = {}, extras: TestExtras = {}) {
  const api = withExtras(createFakeBacklogApi({ items }), extras);
  const props: CommandPaletteProps = {
    projectId: 'p1', currentItem: { id: 'i1', type: 'capability' }, onSelectItem: vi.fn(), onRunIntent: vi.fn(), onNewSession: vi.fn(), debounceMs: 0, ...overrides,
  };
  const rendered = renderWithApi(<><button>outside</button><CommandPalette {...props} /></>, api);
  return { ...rendered, props, api };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('CommandPalette', () => {
  it('opens with Ctrl+K and Cmd+K, toggles, and with the shell event', async () => {
    setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('combobox')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('combobox')).toBeNull();
    act(() => { window.dispatchEvent(new CustomEvent(PALETTE_EVENTS.open)); });
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  it('is a combobox with a grouped listbox, aria-activedescendant, arrow keys and Escape restoring focus', async () => {
    const user = userEvent.setup();
    setup();
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    await user.keyboard('{Control>}k{/Control}');
    const box = await screen.findByRole('combobox');
    const list = await screen.findByRole('listbox', { name: 'Results' });
    await within(list).findByRole('option', { name: /Billing overhaul/ });
    expect(within(list).getAllByRole('group').map((group) => group.getAttribute('aria-labelledby'))).toHaveLength(3);
    const options = within(list).getAllByRole('option');
    expect(box).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveAttribute('aria-activedescendant', options[1].id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(box).toHaveAttribute('aria-activedescendant', options[options.length - 1].id);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(outside).toHaveFocus();
  });

  it('matches item titles on the client and selects with Enter', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'invoice');
    const option = await screen.findByRole('option', { name: /Invoice export/ });
    expect(screen.queryByRole('option', { name: /Queue upgrade/ })).toBeNull();
    expect(option).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(props.onSelectItem).toHaveBeenCalledWith('i2');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('adds semantic hits from the search endpoint with a semantic indicator, without duplicating title matches', async () => {
    const user = userEvent.setup();
    const searchCalls: string[] = [];
    const { props } = setup({}, {
      searchCalls,
      semanticItems: [
        { itemId: 'i2', title: 'Invoice export', type: 'feature', status: 'draft', score: 0.9, snippet: null },
        { itemId: 'i3', title: 'Queue upgrade', type: 'enabler', status: 'draft', score: 0.5, snippet: 'bills are sent from the queue' },
      ],
    });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'invoice');
    const semantic = await screen.findByRole('option', { name: /Queue upgrade/ });
    expect(semantic).toHaveTextContent('semantic');
    expect(semantic).toHaveTextContent('bills are sent from the queue');
    expect(screen.getAllByRole('option', { name: /Invoice export/ })).toHaveLength(1);
    expect(searchCalls.some((call) => call.includes('q=invoice') && call.includes('kind=items'))).toBe(true);
    await user.click(semantic);
    expect(props.onSelectItem).toHaveBeenCalledWith('i3');
  });

  it('runs agent commands with the right intent', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    const open = async (query: string) => {
      await user.keyboard('{Control>}k{/Control}');
      await user.type(await screen.findByRole('combobox'), query);
    };
    await open('assess');
    await user.keyboard('{Enter}');
    expect(props.onRunIntent).toHaveBeenLastCalledWith('assess', undefined);
    await open('break down into enablers');
    await user.keyboard('{Enter}');
    expect(props.onRunIntent).toHaveBeenLastCalledWith('breakdown', 'enabler');
    await open('continue');
    await user.keyboard('{Enter}');
    expect(props.onRunIntent).toHaveBeenLastCalledWith('continue', undefined);
    await open('new session');
    await user.keyboard('{Enter}');
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
  });

  it('disables agent commands while the agent is busy', async () => {
    const user = userEvent.setup();
    const { props } = setup({ agentBusy: true });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'assess');
    const option = await screen.findByRole('option', { name: /Assess quality/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(props.onRunIntent).not.toHaveBeenCalled();
  });

  it('dispatches window events for actions of other components', async () => {
    const user = userEvent.setup();
    setup();
    const seen: string[] = [];
    const names = [PALETTE_EVENTS.newItem, PALETTE_EVENTS.openSources, PALETTE_EVENTS.openSettings, PALETTE_EVENTS.share];
    const listeners = names.map((name) => { const fn = () => seen.push(name); window.addEventListener(name, fn); return [name, fn] as const; });
    for (const [label, query] of [['New item', 'new item'], ['Open sources', 'open sources'], ['Project settings', 'project settings'], ['Share', 'share']]) {
      await user.keyboard('{Control>}k{/Control}');
      await user.type(await screen.findByRole('combobox'), query);
      await user.click(await screen.findByRole('option', { name: new RegExp(label) }));
    }
    listeners.forEach(([name, fn]) => window.removeEventListener(name, fn));
    expect(seen).toEqual(names);
  });

  it('prefers callbacks over events and toggles the theme', async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    setup({ onShare });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'share');
    await user.keyboard('{Enter}');
    expect(onShare).toHaveBeenCalled();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'toggle theme');
    await user.keyboard('{Enter}');
    expect(document.documentElement.dataset.theme).toMatch(/dark|light/);
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  it('says when nothing matches and has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = setup();
    await user.keyboard('{Control>}k{/Control}');
    const box = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: /Billing overhaul/ });
    await expectNoAxeViolations(document.body);
    await user.type(box, 'zzzzqq');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No results'));
    await expectNoAxeViolations(document.body);
    document.documentElement.dataset.theme = 'dark';
    await expectNoAxeViolations(container.ownerDocument.body);
    delete document.documentElement.dataset.theme;
  });
});

describe('agentCommandsFor', () => {
  it('offers break-down per child type', () => {
    expect(agentCommandsFor('capability').filter((c) => c.id === 'break-down').map((c) => [c.slash, c.childType])).toEqual([['break-down', 'feature'], ['break-down-enablers', 'enabler']]);
    expect(agentCommandsFor('user-story').some((c) => c.id === 'break-down')).toBe(false);
  });
});

describe('Composer slash menu', () => {
  function Harness({ onSlash }: { onSlash: (key: string) => void }) {
    const [value, setValue] = useState('');
    return <Composer value={value} busy={false} onChange={setValue} onSubmit={vi.fn()} slashCommands={agentCommandsFor('capability')} onSlashCommand={(command) => onSlash(command.key)} />;
  }

  it('opens on / at the start, filters, navigates and runs with Enter or Tab', async () => {
    const user = userEvent.setup();
    const onSlash = vi.fn();
    const { container } = renderWithApi(<Harness onSlash={onSlash} />, createFakeBacklogApi());
    const box = screen.getByRole('textbox', { name: 'Message the refinement agent' });
    await user.type(box, 'hello /');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.clear(box);
    await user.type(box, '/');
    const list = screen.getByRole('listbox', { name: 'Slash commands' });
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('/break-down'), expect.stringContaining('/assess'), expect.stringContaining('/continue'), expect.stringContaining('/new-session')]));
    expect(box).toHaveAttribute('aria-controls', list.id);
    await expectNoAxeViolations(container);
    await user.type(box, 'as');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(box).toHaveAttribute('aria-activedescendant', within(list).getByRole('option').id);
    await user.keyboard('{Tab}');
    expect(onSlash).toHaveBeenCalledWith('assess');
    expect(box).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.type(box, '/new{Enter}');
    expect(onSlash).toHaveBeenLastCalledWith('new-session');
  });

  it('closes with Escape without sending or stopping, and arrows move the selection', async () => {
    const user = userEvent.setup();
    const onSlash = vi.fn();
    renderWithApi(<Harness onSlash={onSlash} />, createFakeBacklogApi());
    const box = screen.getByRole('textbox', { name: 'Message the refinement agent' });
    await user.type(box, '/');
    const options = screen.getAllByRole('option');
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveValue('/');
    expect(onSlash).not.toHaveBeenCalled();
  });
});
