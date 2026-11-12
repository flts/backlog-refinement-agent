import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PreviewPanel } from './PreviewPanel';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';
import type { BacklogItem } from '../domain/backlog-item';
import type { RefinementSession } from '../domain/refinement-session';

const item = {
  id: 'i1', projectId: 'project-1', type: 'feature', title: 'Export', status: 'draft', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  description: '## Assumptions\n- [ ] Users are logged in\n\n## Open questions\n- [ ] Which format?', revisions: [],
} as unknown as BacklogItem;

describe('PreviewPanel', () => {
  it('lists open uncertainty, edits the title and triggers quality assessment', async () => {
    const user = userEvent.setup();
    const onResolveChecklist = vi.fn();
    const onAssessQuality = vi.fn();
    const onProposeChildren = vi.fn();
    render(<PreviewPanel className="preview" item={item} items={[item]} relationships={[]} session={{ id: 's' } as RefinementSession} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onCopy={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={onResolveChecklist} onUndo={vi.fn()}
      onChangeStatus={vi.fn()} onAssessQuality={onAssessQuality} onProposeChildren={onProposeChildren} />);
    expect(screen.getByText('Users are logged in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm assumption' }));
    expect(onResolveChecklist).toHaveBeenCalledWith(expect.any(Number), 'check', 'Assumption confirmed.');
    await user.click(screen.getByRole('button', { name: 'Assess quality' }));
    expect(onAssessQuality).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /User stories/ }));
    expect(onProposeChildren).toHaveBeenCalledWith('user-story');
  });

  it('shows an empty state without an item', () => {
    render(<PreviewPanel className="preview" items={[]} relationships={[]} busy={false} menuActions={[]} onSelectItem={vi.fn()} onCopy={vi.fn()}
      onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()} onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
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
    render(<PreviewPanel className="preview" item={selected} items={[selected]} relationships={[]} session={{ id: 's' } as RefinementSession} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onCopy={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
      onChangeStatus={onChangeStatus} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    for (const [label, next] of actions) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(onChangeStatus).toHaveBeenLastCalledWith(next);
    }
    expect(onChangeStatus).toHaveBeenCalledTimes(actions.length);
  });

  it('disables marking a draft ready until its session is available', () => {
    render(<PreviewPanel className="preview" item={item} items={[item]} relationships={[]} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onCopy={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
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
    render(<PreviewPanel className="preview" item={selected} items={[selected]} relationships={[]} session={{ id: 's' } as RefinementSession} busy menuActions={[]}
      onSelectItem={vi.fn()} onCopy={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
      onChangeStatus={vi.fn()} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    for (const label of labels) expect(screen.getByRole('button', { name: label })).toBeDisabled();
  });
});

describe('ChatPanel', () => {
  const base = (overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
    className: 'chat', item, sessions: [], busy: false, canRetry: false, message: '', reviewChanges: false, selectedProposals: [],
    session: { id: 's', backlogItemId: 'i1', conversation: [{ id: 'm1', role: 'user', content: 'Hello agent', createdAt: '2026-01-01T10:00:00Z' }] } as unknown as RefinementSession,
    onSelectItem: vi.fn(), onNewSession: vi.fn(), onSwitchSession: vi.fn(), onDeleteSession: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
    onCancel: vi.fn(), onRetry: vi.fn(), onToggleReview: vi.fn(), onApplyPending: vi.fn(), onDiscardPending: vi.fn(), onProposalChange: vi.fn(),
    onSelectedProposalsChange: vi.fn(), onAcceptProposals: vi.fn(), onDismissProposal: vi.fn(), onCreateItem: vi.fn(), ...overrides,
  });

  it('renders the conversation and the retry and cancel controls', async () => {
    const user = userEvent.setup();
    const props = base({ busy: true, canRetry: true });
    render(<ChatPanel {...props} />);
    expect(screen.getByText('Hello agent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cancel request/ }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Retry last request/ })).toBeDisabled();
  });

  it('toggles review mode and offers item creation when nothing is selected', async () => {
    const user = userEvent.setup();
    const props = base();
    const { unmount } = render(<ChatPanel {...props} />);
    await user.click(screen.getByLabelText('Review changes before applying'));
    expect(props.onToggleReview).toHaveBeenCalledWith(true);
    unmount();
    const empty = base({ item: undefined });
    render(<ChatPanel {...empty} />);
    await user.click(screen.getByRole('button', { name: 'Create backlog item' }));
    expect(empty.onCreateItem).toHaveBeenCalledOnce();
  });
});
