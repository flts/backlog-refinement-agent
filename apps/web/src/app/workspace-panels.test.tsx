import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../test/axe';
import { NewItemModal } from './NewItemModal';
import { PreviewPanel } from './PreviewPanel';
import { ChatPanel, type ChatPanelProps } from '../chat';
import type { Item } from '../api';
import { initialRunState, type RunState } from '../run';
import { makeThread } from '../test/fakeAgentBackend';

const item: Item = {
  id: 'i1', projectId: 'project-1', parentId: null, type: 'feature', title: 'Export', status: 'draft', version: 1, documentHash: 'h', quality: null,
  createdBy: 'alice@example.test', updatedBy: 'alice@example.test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  document: '## Assumptions\n- [ ] Users are logged in\n\n## Open questions\n- [ ] Which format?',
};
describe('PreviewPanel', () => {
  it('lists open uncertainty, edits the title and triggers quality assessment', async () => {
    const user = userEvent.setup();
    const onResolveChecklist = vi.fn();
    const onAssessQuality = vi.fn();
    const onProposeChildren = vi.fn();
    render(<PreviewPanel className="preview" item={item} session={{ id: 's' }} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={onResolveChecklist}
      onChangeStatus={vi.fn()} onAssessQuality={onAssessQuality} onProposeChildren={onProposeChildren} />);
    expect(screen.getByRole('tab', { name: 'Open items (2)' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Open items/ }));
    expect(screen.getByText('Users are logged in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm assumption' }));
    expect(onResolveChecklist).toHaveBeenCalledWith(expect.any(Number), 'check', 'Assumption confirmed.');
    await user.click(screen.getByRole('button', { name: 'Assess quality' }));
    expect(onAssessQuality).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /User stories/ }));
    expect(onProposeChildren).toHaveBeenCalledWith('user-story');
  });

  it('shows an empty state without an item', () => {
    render(<PreviewPanel className="preview" busy={false} menuActions={[]} onSelectItem={vi.fn()}
      onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    expect(screen.getByText('Your item preview')).toBeInTheDocument();
  });

  it.each([
    ['draft', [['Mark ready', 'ready']]],
    ['refining', [['Mark ready', 'ready']]],
    ['ready', [['Mark complete', 'complete'], ['Return to refining', 'refining']]],
    ['ready-with-open-questions', [['Mark ready', 'ready'], ['Return to refining', 'refining']]],
    ['complete', [['Reopen item', 'refining']]],
  ] as const)('offers appropriate manual actions for %s', async (status, actions) => {
    const user = userEvent.setup();
    const onChangeStatus = vi.fn();
    const selected = { ...item, status };
    render(<PreviewPanel className="preview" item={selected} session={{ id: 's' }} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()}
      onChangeStatus={onChangeStatus} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    for (const [label, next] of actions) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(onChangeStatus).toHaveBeenLastCalledWith(next);
    }
    expect(onChangeStatus).toHaveBeenCalledTimes(actions.length);
  });

  it('disables marking a draft ready until its session is available', () => {
    render(<PreviewPanel className="preview" item={item} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()}
      onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();
  });

  it.each([
    ['draft', ['Mark ready']],
    ['refining', ['Mark ready']],
    ['ready', ['Mark complete', 'Return to refining']],
    ['ready-with-open-questions', ['Mark ready', 'Return to refining']],
    ['complete', ['Reopen item']],
  ] as const)('disables %s status actions during a request', (status, labels) => {
    const selected = { ...item, status };
    render(<PreviewPanel className="preview" item={selected} session={{ id: 's' }} busy menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()}
      onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    for (const label of labels) expect(screen.getByRole('button', { name: label })).toBeDisabled();
  });
});

describe('ChatPanel', () => {
  const run = (overrides: Partial<RunState> = {}): RunState => ({ ...initialRunState('t'), phase: 'idle', messages: [{ kind: 'user', id: 'm1', text: 'Hello agent' }], ...overrides });
  const base = (overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
    className: 'chat', item, threads: [], run: run(), busy: false, canRetry: false, message: '',
    onSelectItem: vi.fn(), onNewThread: vi.fn(), onSelectThread: vi.fn(), onRenameThread: vi.fn(), onDeleteThread: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
    onStop: vi.fn(), onRetry: vi.fn(), onAnswer: vi.fn(), onDecideAll: vi.fn(), onCreateItem: vi.fn(), ...overrides,
  });

  it('renders the conversation and the stop and retry controls', async () => {
    const user = userEvent.setup();
    const props = base({ run: run({ phase: 'running' }), busy: true });
    render(<ChatPanel {...props} />);
    expect(screen.getByText('Hello agent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  it('offers item creation when nothing is selected', async () => {
    const user = userEvent.setup();
    const empty = base({ item: undefined });
    render(<ChatPanel {...empty} />);
    await user.click(screen.getByRole('button', { name: 'Create backlog item' }));
    expect(empty.onCreateItem).toHaveBeenCalledOnce();
  });

  it('shows the session picker even for one thread and disables it while running', () => {
    const thread = makeThread({ id: 's', title: 'Scope' });
    const { rerender } = render(<ChatPanel {...base({ threads: [thread], activeThreadId: 's' })} />);
    expect(screen.getByRole('button', { name: 'Sessions. Current: Scope' })).toBeEnabled();
    rerender(<ChatPanel {...base({ threads: [thread], activeThreadId: 's', run: run({ phase: 'running' }), busy: true })} />);
    expect(screen.getByRole('button', { name: 'Sessions. Current: Scope' })).toBeDisabled();
  });
});

describe('accessibility', () => {
  const chatProps = (overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
    className: 'chat', item, threads: [], run: { ...initialRunState('t'), phase: 'idle', messages: [{ kind: 'user', id: 'm1', text: 'Hello agent' }] }, busy: false, canRetry: false, message: '',
    onSelectItem: vi.fn(), onNewThread: vi.fn(), onSelectThread: vi.fn(), onRenameThread: vi.fn(), onDeleteThread: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
    onStop: vi.fn(), onRetry: vi.fn(), onAnswer: vi.fn(), onDecideAll: vi.fn(), onCreateItem: vi.fn(), ...overrides,
  });
  const running = { ...initialRunState('t'), phase: 'running' as const };

  it('ChatPanel has no axe violations and announces agent activity', async () => {
    const { container, rerender } = render(<ChatPanel {...chatProps()} />);
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    rerender(<ChatPanel {...chatProps({ busy: true, run: running })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Agent is working');
    rerender(<ChatPanel {...chatProps({ busy: false })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Agent replied');
  });

  it('PreviewPanel has no axe violations', async () => {
    const { container } = render(<PreviewPanel className="preview" item={item} session={{ id: 's' }} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()}
      onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    await expectNoAxeViolations(container);
  });

  it('NewItemModal is a labelled dialog without axe violations that closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<NewItemModal type="feature" title="" onTypeChange={vi.fn()} onTitleChange={vi.fn()} onSubmit={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'What are we shaping?' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
