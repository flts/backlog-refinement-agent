import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Relationship } from '../api';
import { Composer } from '../chat';
import { PALETTE_EVENTS } from '../palette';
import { withExtras, type TestExtras } from '../palette/testApi';
import { expectNoAxeViolations } from '../test/axe';
import { createFakeBacklogApi, makeItem, makeSource } from '../test/fakeBacklogApi';
import { renderWithApi } from '../test/render';
import { ContextBar, displayMentions, findMention, insertMention, mentionText, type MentionCandidate } from '.';

const rel = (id: string, sourceId: string, targetId: string, type: Relationship['type']): Relationship => ({ id, projectId: 'p1', sourceId, targetId, type });
const items = [
  makeItem({ id: 'cap', type: 'capability', title: 'Billing overhaul' }),
  makeItem({ id: 'feat', type: 'feature', title: 'Invoice export', parentId: 'cap' }),
  makeItem({ id: 'other', type: 'feature', title: 'Tax rules' }),
];
const relationships = [rel('r1', 'cap', 'feat', 'parent-child'), rel('r2', 'feat', 'other', 'depends-on')];
const sources = [makeSource({ id: 's1', mode: 'pinned' }), makeSource({ id: 's2', mode: 'searchable' }), makeSource({ id: 's3', mode: 'searchable' }), makeSource({ id: 's4', mode: 'excluded' })];

function setup(extras: TestExtras = {}, onSelectItem = vi.fn()) {
  const api = withExtras(createFakeBacklogApi({ items, relationships, sources }), { pinnedBudget: { used: 25000, limit: 100000 }, ...extras });
  const view = renderWithApi(<ContextBar projectId="p1" item={{ id: 'feat', type: 'feature', title: 'Invoice export' }} onSelectItem={onSelectItem} />, api);
  return { ...view, onSelectItem };
}

describe('ContextBar', () => {
  it('shows the item, parent, related count, source counts with budget meter and the default template', async () => {
    setup();
    expect(await screen.findByLabelText(/Current item: Feature Invoice export/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Parent: Billing overhaul/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '1 related item' })).toBeInTheDocument();
    expect(await screen.findByText('1 pinned · 2 searchable')).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: 'Pinned budget' });
    expect(meter).toHaveAttribute('aria-valuenow', '25000');
    expect(meter).toHaveAttribute('aria-valuetext', '25% of the pinned budget used');
    expect(await screen.findByText('Default template v1.2')).toBeInTheDocument();
  });

  it('labels a project override as Project template', async () => {
    setup({ projectTemplates: ['feature'] });
    expect(await screen.findByText('Project template')).toBeInTheDocument();
    expect(screen.queryByText(/Default template/)).toBeNull();
  });

  it('every chip is focusable and has a tooltip', async () => {
    const user = userEvent.setup();
    setup();
    const chip = (await screen.findByLabelText(/Current item/));
    await user.tab();
    expect(chip).toHaveFocus();
    expect(chip).toHaveAccessibleDescription(/refining/);
    const sourcesChip = await screen.findByLabelText(/Sources: 1 pinned, 2 searchable/);
    expect(sourcesChip).toHaveAttribute('tabindex', '0');
    expect(sourcesChip).toHaveAccessibleDescription(/Pinned sources/);
    expect(await screen.findByLabelText(/Template: /)).toHaveAttribute('tabindex', '0');
  });

  it('opens the related popover, selects an item, and closes with Escape returning focus', async () => {
    const user = userEvent.setup();
    const { onSelectItem } = setup();
    const trigger = await screen.findByRole('button', { name: '1 related item' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const popover = screen.getByRole('group', { name: 'Related items' });
    expect(within(popover).getByRole('button', { name: /Tax rules.*Depends on/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Related items' })).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: /Tax rules/ }));
    expect(onSelectItem).toHaveBeenCalledWith('other');
  });

  it('selects the parent and asks the sources drawer to open', async () => {
    const user = userEvent.setup();
    const { onSelectItem } = setup();
    await user.click(await screen.findByRole('button', { name: /Parent: Billing overhaul/ }));
    expect(onSelectItem).toHaveBeenCalledWith('cap');
    const seen = vi.fn();
    window.addEventListener(PALETTE_EVENTS.openSources, seen);
    await user.click(screen.getByRole('button', { name: 'Manage sources' }));
    window.removeEventListener(PALETTE_EVENTS.openSources, seen);
    expect(seen).toHaveBeenCalled();
  });

  it('has no axe violations in light and dark', async () => {
    const { container } = setup();
    await screen.findByText('Default template v1.2');
    await screen.findByRole('button', { name: '1 related item' });
    await expectNoAxeViolations(container);
    document.documentElement.dataset.theme = 'dark';
    await expectNoAxeViolations(container);
    delete document.documentElement.dataset.theme;
  });
});

describe('mention helpers', () => {
  const item: MentionCandidate = { id: 'abc', title: 'Invoice [v2]\nexport', typeLabel: 'Feature' };
  it('finds an @ trigger only at the start or after whitespace', () => {
    expect(findMention('hi @inv', 7)).toEqual({ start: 3, end: 7, query: 'inv' });
    expect(findMention('mail@inv', 8)).toBeUndefined();
    expect(findMention('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });
  it('inserts @[Title](item:id), sanitising brackets, and displays it as @Title', () => {
    expect(mentionText(item)).toBe('@[Invoice v2 export](item:abc)');
    const trigger = findMention('see @inv', 8)!;
    const result = insertMention('see @inv', trigger, item);
    expect(result.value).toBe('see @[Invoice v2 export](item:abc) ');
    expect(result.caret).toBe(result.value.length);
    expect(displayMentions(result.value)).toBe('see @Invoice v2 export ');
  });
});

describe('Composer @-mention picker', () => {
  const mentionItems: MentionCandidate[] = [
    { id: 'a1', title: 'Billing overhaul', typeLabel: 'Capability' },
    { id: 'a2', title: 'Invoice export', typeLabel: 'Feature' },
    { id: 'a3', title: 'Tax rules', typeLabel: 'Feature' },
  ];
  function Harness() {
    const [value, setValue] = useState('');
    return <Composer value={value} busy={false} onChange={setValue} onSubmit={vi.fn()} mentionItems={mentionItems} />;
  }

  it('filters by title and inserts the mention with Enter or click; Escape closes', async () => {
    const user = userEvent.setup();
    const { container } = renderWithApi(<Harness />, createFakeBacklogApi());
    const box = screen.getByRole('textbox', { name: 'Message the refinement agent' });
    await user.type(box, 'Compare with @');
    const list = screen.getByRole('listbox', { name: 'Mention an item' });
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    await expectNoAxeViolations(container);
    await user.type(box, 'inv');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('Compare with @[Invoice export](item:a2) ');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.type(box, 'and @tax');
    await user.click(screen.getByRole('option', { name: /Tax rules/ }));
    expect(box).toHaveValue('Compare with @[Invoice export](item:a2) and @[Tax rules](item:a3) ');
    await user.type(box, '@bil');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveValue('Compare with @[Invoice export](item:a2) and @[Tax rules](item:a3) @bil');
  });

  it('arrow keys choose another option', async () => {
    const user = userEvent.setup();
    renderWithApi(<Harness />, createFakeBacklogApi());
    const box = screen.getByRole('textbox', { name: 'Message the refinement agent' });
    await user.type(box, '@');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(box).toHaveValue('@[Tax rules](item:a3) ');
  });
});
