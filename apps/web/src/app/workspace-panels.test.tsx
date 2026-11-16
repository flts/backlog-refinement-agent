import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '../test/axe';
import { NewItemModal } from './NewItemModal';
import { PreviewPanel } from './PreviewPanel';
import { ChatPanel, type ChatPanelProps } from './ChatPanel';
import { ProjectPanel } from './ProjectPanel';
import type { Item, Project, Source } from '../api';
import type { RefinementSession } from '../domain/refinement-session';

const item: Item = {
  id: 'i1', projectId: 'project-1', parentId: null, type: 'feature', title: 'Export', status: 'draft', version: 1, documentHash: 'h', quality: null,
  createdBy: 'alice@example.test', updatedBy: 'alice@example.test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  document: '## Assumptions\n- [ ] Users are logged in\n\n## Open questions\n- [ ] Which format?',
};
const project: Project = { id: 'p', name: 'Project', version: 1, role: 'owner', createdBy: 'alice@example.test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const source: Source = {
  id: 's1', projectId: 'p', name: 'Spec', kind: 'url', mode: 'searchable', url: 'https://example.com/spec', charCount: 1200, pageCount: null, mediaType: null, hasFile: false,
  indexStatus: 'indexed', indexError: null, version: 1, addedBy: 'alice@example.test', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const noop = { onSelect: vi.fn(), onCreate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onAddFile: vi.fn(), onAddUrl: vi.fn(), onChangeMode: vi.fn(), onRemove: vi.fn(), onExport: vi.fn(), onImport: vi.fn() };

describe('ProjectPanel', () => {
  it('opens the styled file picker and passes the selected file to its handler', async () => {
    const user = userEvent.setup();
    const onAddFile = vi.fn();
    const { container } = render(<ProjectPanel {...noop} projects={[project]} project={project} sources={[]} busy={false} onAddFile={onAddFile} />);
    await user.click(screen.getByText('Project sources (0)'));
    const input = container.querySelector<HTMLInputElement>('input[accept^=".pdf"]')!;
    const click = vi.spyOn(input, 'click');
    await user.click(screen.getByRole('button', { name: 'Add PDF or text file' }));
    expect(click).toHaveBeenCalledOnce();
    const file = new File(['Context'], 'context.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAddFile).toHaveBeenCalledWith(file);
  });

  it('changes the mode of a source and shows its index status', async () => {
    const user = userEvent.setup();
    const onChangeMode = vi.fn();
    render(<ProjectPanel {...noop} projects={[project]} project={project} sources={[source]} pinnedBudget={{ used: 0, limit: 100000 }} busy={false} onChangeMode={onChangeMode} />);
    await user.click(screen.getByText('Project sources (1)'));
    expect(screen.getByText('Indexed')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Mode of Spec'), 'pinned');
    expect(onChangeMode).toHaveBeenCalledWith(source, 'pinned');
  });

  it('offers rename, delete and export to owners only', () => {
    const { rerender } = render(<ProjectPanel {...noop} projects={[project]} project={project} sources={[]} busy={false} />);
    for (const name of ['Rename project', 'Delete project', 'Export project']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    rerender(<ProjectPanel {...noop} projects={[{ ...project, role: 'contributor' }]} project={{ ...project, role: 'contributor' }} sources={[]} busy={false} />);
    for (const name of ['Rename project', 'Delete project', 'Export project']) expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('PreviewPanel', () => {
  it('lists open uncertainty, edits the title and triggers quality assessment', async () => {
    const user = userEvent.setup();
    const onResolveChecklist = vi.fn();
    const onAssessQuality = vi.fn();
    const onProposeChildren = vi.fn();
    render(<PreviewPanel className="preview" item={item} session={{ id: 's' } as RefinementSession} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={onResolveChecklist} onUndo={vi.fn()}
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
    render(<PreviewPanel className="preview" busy={false} menuActions={[]} onSelectItem={vi.fn()}
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
    render(<PreviewPanel className="preview" item={selected} session={{ id: 's' } as RefinementSession} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
      onChangeStatus={onChangeStatus} onAssessQuality={vi.fn()} onProposeChildren={vi.fn()} />);
    for (const [label, next] of actions) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(onChangeStatus).toHaveBeenLastCalledWith(next);
    }
    expect(onChangeStatus).toHaveBeenCalledTimes(actions.length);
  });

  it('disables marking a draft ready until its session is available', () => {
    render(<PreviewPanel className="preview" item={item} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
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
    render(<PreviewPanel className="preview" item={selected} session={{ id: 's' } as RefinementSession} busy menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
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

  it('shows the session selector even for one session and disables it while busy', () => {
    const session: RefinementSession = { id: 's', backlogItemId: 'i1', conversation: [], pendingQuestions: [], status: 'active', forceGeneration: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const { rerender } = render(<ChatPanel {...base({ session, sessions: [session] })} />);
    expect(screen.getByRole('combobox', { name: 'Choose refinement session' })).toHaveValue('s');
    rerender(<ChatPanel {...base({ session, sessions: [session], busy: true })} />);
    expect(screen.getByRole('combobox', { name: 'Choose refinement session' })).toBeDisabled();
  });
});

describe('accessibility', () => {
  const chatProps = (overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
    className: 'chat', item, sessions: [], busy: false, canRetry: false, message: '', reviewChanges: false, selectedProposals: [],
    session: { id: 's', backlogItemId: 'i1', conversation: [{ id: 'm1', role: 'user', content: 'Hello agent', createdAt: '2026-01-01T10:00:00Z' }] } as unknown as RefinementSession,
    onSelectItem: vi.fn(), onNewSession: vi.fn(), onSwitchSession: vi.fn(), onDeleteSession: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
    onCancel: vi.fn(), onRetry: vi.fn(), onToggleReview: vi.fn(), onApplyPending: vi.fn(), onDiscardPending: vi.fn(), onProposalChange: vi.fn(),
    onSelectedProposalsChange: vi.fn(), onAcceptProposals: vi.fn(), onDismissProposal: vi.fn(), onCreateItem: vi.fn(), ...overrides,
  });

  it('ChatPanel has no axe violations and announces agent activity', async () => {
    const { container, rerender } = render(<ChatPanel {...chatProps()} />);
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    rerender(<ChatPanel {...chatProps({ busy: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/responding/);
    rerender(<ChatPanel {...chatProps({ busy: false })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/finished/);
  });

  it('PreviewPanel has no axe violations', async () => {
    const { container } = render(<PreviewPanel className="preview" item={item} session={{ id: 's' } as RefinementSession} busy={false} menuActions={[]}
      onSelectItem={vi.fn()} onUpdate={vi.fn()} onResolveChecklist={vi.fn()} onUndo={vi.fn()}
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
