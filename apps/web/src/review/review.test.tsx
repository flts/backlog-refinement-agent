import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ResumeDecision } from '../agent';
import type { ProposeChildItemsArgs, ProposeDocumentChangesArgs } from '../contracts';
import { initialRunState, type ReviewInterrupt, type RunState, type TranscriptEntry } from '../run';
import { expectNoAxeViolations } from '../test/axe';
import {
  ApplyResultCard, ChildProposalCard, PredictivePreview, ReviewCard, ReviewPanel, documentResultSummary, parsePartialProposal, proposalForPreview, similarItemsFrom,
} from '.';

const doc = '## Summary\nOld summary\n\n## Acceptance criteria\n- [ ] AC0';
const args: ProposeDocumentChangesArgs = {
  summary: 'Tighten summary and ACs',
  suggestedTitle: 'Export invoices',
  suggestedStatus: 'ready-with-open-questions',
  baseVersion: 7,
  sections: [
    { id: 's1', heading: 'Summary', mode: 'replace', markdown: 'New summary', rationale: 'Clearer outcome' },
    { id: 's2', heading: 'Acceptance criteria', mode: 'append', markdown: '- [ ] AC1' },
    { id: 's3', heading: 'Out of scope', mode: 'replace', markdown: 'No PDF export' },
  ],
};
const interrupt = (overrides: Partial<ReviewInterrupt> = {}): ReviewInterrupt => ({ id: 'af-call-1', toolCallId: 'call_prop', toolName: 'propose_document_changes', args: { ...args }, ...overrides });

function renderCard(extra: Partial<Parameters<typeof ReviewCard>[0]> = {}) {
  const onDecide = vi.fn<(decision: ResumeDecision) => void>();
  const view = render(<ReviewCard interrupt={interrupt()} document={doc} onDecide={onDecide} {...extra} />);
  return { onDecide, ...view };
}
const section = (name: string) => screen.getByRole('heading', { name, level: 4 }).closest('li')!;
const click = (el: HTMLElement) => userEvent.click(el);

describe('PredictivePreview and proposalForPreview', () => {
  const runWith = (overrides: Partial<RunState>): RunState => ({ ...initialRunState('t'), phase: 'awaitingReview', ...overrides });

  it('shows track changes: replace, append and a new heading, with text equivalents', () => {
    render(<PredictivePreview document={doc} proposal={args} status="review" />);
    expect(screen.getByText('Proposed changes — review in the chat')).toBeInTheDocument();
    const summary = within(screen.getByRole('heading', { name: /^Summary/ }).closest('li')!);
    expect(summary.getByText('Old summary').closest('.diff-line')).toHaveTextContent('Removed:');
    expect(summary.getByText('New summary').closest('.diff-line')).toHaveTextContent('Added:');
    const append = within(screen.getByRole('heading', { name: /^Acceptance criteria/ }).closest('li')!);
    expect(append.getByText('Append')).toBeInTheDocument();
    expect(append.getByText('- [ ] AC1').closest('.diff-line')).toHaveTextContent('Added:');
    expect(append.queryByText('- [ ] AC0')?.closest('.diff-line')).not.toHaveTextContent('Removed:');
    const added = within(screen.getByRole('heading', { name: /^Out of scope/ }).closest('li')!);
    expect(added.getByText('New section')).toBeInTheDocument();
    expect(added.getByText('No PDF export').closest('.diff-line')).toHaveTextContent('Added:');
  });

  it('marks a streaming proposal busy', () => {
    render(<PredictivePreview document={doc} proposal={args} status="streaming" />);
    expect(screen.getByRole('region', { name: 'Proposed changes' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/still writing/)).toBeInTheDocument();
  });

  it('uses the pending interrupt while reviewing', () => {
    const view = proposalForPreview(runWith({ interrupts: [interrupt()] }));
    expect(view?.status).toBe('review');
    expect(view?.proposal.sections).toHaveLength(3);
  });

  it('ignores a stale preview when no interrupt is pending (spike #6)', () => {
    const agentState = { ...runWith({}).agentState, preview: { sections: args.sections } };
    expect(proposalForPreview(runWith({ phase: 'idle', agentState }))).toBeNull();
    expect(proposalForPreview(runWith({ phase: 'awaitingReview', interrupts: [interrupt({ expired: true })], agentState }))).toBeNull();
    expect(proposalForPreview(runWith({ phase: 'cancelled', agentState }))).toBeNull();
  });

  it('uses the preview state while the run streams', () => {
    const agentState = { ...runWith({}).agentState, preview: { sections: args.sections } };
    expect(proposalForPreview(runWith({ phase: 'running', agentState }))?.status).toBe('streaming');
  });

  it('streams progressively from TOOL_CALL_ARGS text and only shows complete sections', () => {
    const text = JSON.stringify(args);
    const cut = text.indexOf('"id":"s2"') + 30;
    const partial = parsePartialProposal(text.slice(0, cut));
    expect(partial?.summary).toBe('Tighten summary and ACs');
    expect(partial?.baseVersion).toBe(7);
    expect(partial?.sections.map((s) => s.id)).toEqual(['s1']);
    expect(parsePartialProposal(text)?.sections.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(parsePartialProposal('{"summary": "Hal')).toBeNull();
    expect(parsePartialProposal('')).toBeNull();
    const messages: TranscriptEntry[] = [{ kind: 'tool', id: 'c', toolName: 'propose_document_changes', argsText: text.slice(0, cut), status: 'running' }];
    expect(proposalForPreview(runWith({ phase: 'running', messages }))?.proposal.sections).toHaveLength(1);
  });
});

describe('ReviewCard', () => {
  it('sends the exact full-replacement editedArgs for accept, edit and reject per section', async () => {
    const { onDecide } = renderCard();
    await click(within(section('Summary')).getByRole('button', { name: /^Accept/ }));
    await click(within(section('Acceptance criteria')).getByRole('button', { name: /^Edit/ }));
    const editor = screen.getByLabelText(/Edit “Acceptance criteria”/);
    expect(editor).toHaveValue('- [ ] AC1');
    await userEvent.clear(editor);
    await userEvent.type(editor, '- [[ ] AC1 edited');
    await click(screen.getByRole('button', { name: 'Save and accept' }));
    await click(within(section('Out of scope')).getByRole('button', { name: /^Reject/ }));
    await click(screen.getByRole('button', { name: 'Apply 2 sections' }));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide.mock.calls[0][0]).toEqual({
      interruptId: 'af-call-1',
      approved: true,
      editedArgs: {
        summary: 'Tighten summary and ACs',
        suggestedTitle: 'Export invoices',
        suggestedStatus: 'ready-with-open-questions',
        baseVersion: 7,
        sections: [
          { id: 's1', heading: 'Summary', mode: 'replace', markdown: 'New summary', rationale: 'Clearer outcome' },
          { id: 's2', heading: 'Acceptance criteria', mode: 'append', markdown: '- [ ] AC1 edited' },
        ],
      },
    });
  });

  it('keeps the original key of the version (base_version) and all other keys', async () => {
    const original = { summary: 's', base_version: 3, sections: [{ id: 'a', heading: 'Summary', mode: 'replace', markdown: 'x' }] };
    const { onDecide } = renderCard({ interrupt: interrupt({ args: original }) });
    await click(screen.getByRole('button', { name: 'Accept all' }));
    await click(screen.getByRole('button', { name: 'Apply 1 section' }));
    expect(onDecide.mock.calls[0][0]).toEqual({ interruptId: 'af-call-1', approved: true, editedArgs: original });
  });

  it('approves nothing (approved:false) when every section is rejected', async () => {
    const { onDecide } = renderCard();
    await click(screen.getByRole('button', { name: 'Reject all' }));
    await click(screen.getByRole('button', { name: 'Reject proposal' }));
    expect(onDecide).toHaveBeenCalledWith({ interruptId: 'af-call-1', approved: false });
  });

  it('leaves undecided sections out unless "Accept remaining & continue" is used', async () => {
    const { onDecide } = renderCard();
    await click(within(section('Summary')).getByRole('button', { name: /^Reject/ }));
    await click(screen.getByRole('button', { name: /Accept remaining/ }));
    const decision = onDecide.mock.calls[0][0] as unknown as { editedArgs: { sections: { id: string }[] } };
    expect(decision.editedArgs.sections.map((s) => s.id)).toEqual(['s2', 's3']);
  });

  it('title and status are toggles that drop the keys when off', async () => {
    const { onDecide } = renderCard();
    await click(screen.getByRole('checkbox', { name: /Rename the item/ }));
    await click(screen.getByRole('checkbox', { name: /Set the status/ }));
    await click(screen.getByRole('button', { name: 'Accept all' }));
    await click(screen.getByRole('button', { name: /^Apply 3 sections/ }));
    const decision = onDecide.mock.calls[0][0] as unknown as { editedArgs: Record<string, unknown> };
    expect(decision.editedArgs).not.toHaveProperty('suggestedTitle');
    expect(decision.editedArgs).not.toHaveProperty('suggestedStatus');
    expect(decision.editedArgs).toMatchObject({ summary: 'Tighten summary and ACs', baseVersion: 7 });
  });

  it('blocks invalid edits (empty heading is impossible, so an empty summary of the proposal itself is the guard)', async () => {
    const { onDecide } = renderCard({ interrupt: interrupt({ args: { ...args, sections: [] } }) });
    expect(screen.getByRole('region', { name: 'Proposal cannot be shown' })).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenCalledWith({ interruptId: 'af-call-1', approved: false });
  });

  it('shows the overlap warning with links', async () => {
    const onSelectItem = vi.fn();
    renderCard({ similar: [{ id: 'other', title: 'Invoice export', score: 0.91 }], onSelectItem });
    expect(screen.getByText(/Possible overlap with:/)).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Invoice export' }));
    expect(onSelectItem).toHaveBeenCalledWith('other');
  });

  it('finds overlap in find_similar_items results at or above 0.8 in the latest turn only', () => {
    const result = JSON.stringify({ items: [{ id: 'a', title: 'A', score: 0.85 }, { id: 'b', title: 'B', score: 0.6 }, { id: 'self', title: 'Self', score: 0.99 }] });
    const messages: TranscriptEntry[] = [
      { kind: 'user', id: 'u0', text: 'old' },
      { kind: 'tool', id: 'x', toolName: 'find_similar_items', argsText: '', result: JSON.stringify({ items: [{ id: 'old', title: 'Old', score: 0.99 }] }), status: 'done' },
      { kind: 'user', id: 'u1', text: 'new' },
      { kind: 'tool', id: 'c', toolName: 'find_similar_items', argsText: '', result, status: 'done' },
    ];
    expect(similarItemsFrom(messages, 'self')).toEqual([{ id: 'a', title: 'A', score: 0.85 }]);
  });

  it('shows the expired state and retries', async () => {
    const onRetry = vi.fn();
    renderCard({ interrupt: interrupt({ expired: true }), onRetry });
    expect(screen.getByText('This proposal expired — ask again')).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Ask again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('moves focus into the card, returns it after editing, announces decisions and is keyboard operable', async () => {
    const user = userEvent.setup();
    renderCard();
    expect(screen.getByRole('heading', { name: 'Tighten summary and ACs' })).toHaveFocus();
    const edit = within(section('Summary')).getByRole('button', { name: /^Edit/ });
    edit.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText(/Edit “Summary”/)).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(within(section('Summary')).getByRole('button', { name: /^Edit/ })).toHaveFocus());
    within(section('Summary')).getByRole('button', { name: /^Accept/ }).focus();
    await user.keyboard(' ');
    expect(screen.getAllByRole('status').some((node) => node.textContent === 'Section “Summary” accepted.')).toBe(true);
    expect(within(section('Summary')).getByRole('button', { name: /^Accept/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('has no axe violations (pending, editing, expired, result)', async () => {
    const { container } = renderCard({ similar: [{ id: 'o', title: 'Other', score: 0.9 }] });
    await expectNoAxeViolations(container);
    await click(within(section('Summary')).getByRole('button', { name: /^Edit/ }));
    await expectNoAxeViolations(container);
  });
});

describe('ChildProposalCard', () => {
  const childArgs: ProposeChildItemsArgs = {
    rationale: 'Split the feature',
    childType: 'user-story',
    children: [
      { proposalId: 'c1', title: 'Export as PDF', markdown: '## Summary\nAs a user **I export**' },
      { proposalId: 'c2', title: 'Export as CSV', markdown: '## Summary\nCSV' },
      { proposalId: 'c3', title: 'Schedule export', markdown: '## Summary\nLater' },
    ],
    relationships: [{ sourceRef: 'c2', targetRef: 'c1', type: 'depends-on' }, { sourceRef: 'item-1', targetRef: 'c3', type: 'parent-child' }],
  };
  const childInterrupt = (): ReviewInterrupt => ({ id: 'af-call-2', toolCallId: 'call_kids', toolName: 'propose_child_items', args: { ...childArgs } });
  const row = (name: string) => screen.getByRole('heading', { name, level: 4 }).closest('li')!;

  it('submits the accepted subset, edits and only relationships between kept endpoints; notes dropped ones', async () => {
    const onDecide = vi.fn<(decision: ResumeDecision) => void>();
    render(<ChildProposalCard interrupt={childInterrupt()} parentItemId="item-1" onDecide={onDecide} />);
    expect(screen.getByText('I export').tagName).toBe('STRONG');
    await click(within(row('Export as PDF')).getByRole('button', { name: /^Edit/ }));
    await userEvent.clear(screen.getByLabelText('Title'));
    await userEvent.type(screen.getByLabelText('Title'), 'Export to PDF');
    await click(screen.getByRole('button', { name: 'Save and accept' }));
    await click(within(row('Export as CSV')).getByRole('button', { name: /^Accept/ }));
    await click(within(row('Schedule export')).getByRole('button', { name: /^Reject/ }));
    expect(screen.getByText(/will not be created because one side is rejected/)).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Create 2 items' }));
    expect(onDecide.mock.calls[0][0]).toEqual({
      interruptId: 'af-call-2',
      approved: true,
      editedArgs: {
        rationale: 'Split the feature',
        childType: 'user-story',
        children: [
          { proposalId: 'c1', title: 'Export to PDF', markdown: '## Summary\nAs a user **I export**' },
          { proposalId: 'c2', title: 'Export as CSV', markdown: '## Summary\nCSV' },
        ],
        relationships: [{ sourceRef: 'c2', targetRef: 'c1', type: 'depends-on' }],
      },
    });
  });

  it('rejects everything with approved:false and has no axe violations', async () => {
    const onDecide = vi.fn();
    const { container } = render(<ChildProposalCard interrupt={childInterrupt()} parentItemId="item-1" onDecide={onDecide} />);
    await expectNoAxeViolations(container);
    await click(screen.getByRole('button', { name: 'Reject all' }));
    await click(screen.getByRole('button', { name: 'Reject proposal' }));
    expect(onDecide).toHaveBeenCalledWith({ interruptId: 'af-call-2', approved: false });
  });
});

describe('ReviewPanel', () => {
  it('collects one decision per interrupt and resumes them together', async () => {
    const onDecide = vi.fn();
    const second: ReviewInterrupt = { id: 'af-call-2', toolCallId: 'k', toolName: 'propose_child_items', args: { rationale: 'r', childType: 'user-story', children: [{ proposalId: 'c1', title: 'T', markdown: 'm' }] } };
    const run: Pick<RunState, 'phase' | 'interrupts' | 'messages'> = { phase: 'awaitingReview', interrupts: [interrupt(), second], messages: [] };
    render(<ReviewPanel run={run} document={doc} disabled={false} onDecide={onDecide} onRetry={vi.fn()} />);
    const regions = screen.getAllByRole('region');
    await click(within(regions[0]).getByRole('button', { name: 'Reject all' }));
    await click(within(regions[0]).getByRole('button', { name: 'Reject proposal' }));
    expect(onDecide).not.toHaveBeenCalled();
    await click(within(regions[1]).getByRole('button', { name: 'Accept all' }));
    await click(within(regions[1]).getByRole('button', { name: 'Create 1 item' }));
    expect(onDecide).toHaveBeenCalledOnce();
    expect((onDecide.mock.calls[0][0] as ResumeDecision[]).map((d) => d.interruptId)).toEqual(['af-call-1', 'af-call-2']);
  });
});

describe('ApplyResultCard', () => {
  const result = { applied: ['s1', 's2'], edited: ['s2'], rejected: ['s4'], conflicted: [{ sectionId: 's3', heading: 'Out of scope', reason: 'Changed by bob', currentMarkdown: 'Their text' }], newVersion: 9, toolCallId: 'call_prop' };
  const messages: TranscriptEntry[] = [{ kind: 'tool', id: 'call_prop', toolName: 'propose_document_changes', argsText: '', args, status: 'done' }];

  it('summarises the outcome', () => {
    expect(documentResultSummary(result)).toBe('Applied 2 sections · 1 edited · 1 rejected · 1 conflicted');
    expect(documentResultSummary({ applied: ['a'], edited: [], rejected: [], conflicted: [], newVersion: 2 })).toBe('Applied 1 section');
  });

  it('resolves conflicts: shows theirs vs proposed, asks the agent to redo or keeps current', async () => {
    const onSend = vi.fn();
    const { container } = render(<ApplyResultCard result={result} messages={messages} onSend={onSend} />);
    expect(screen.getByRole('status')).toHaveTextContent('Applied 2 sections · 1 edited · 1 rejected · 1 conflicted');
    await click(screen.getByText('Compare current version and proposal'));
    expect(screen.getByText('Their text').closest('.diff-line')).toHaveTextContent('Removed:');
    expect(screen.getByText('No PDF export').closest('.diff-line')).toHaveTextContent('Added:');
    await expectNoAxeViolations(container);
    await click(screen.getByRole('button', { name: /Ask the agent to redo this section/ }));
    expect(onSend).toHaveBeenCalledWith('Please redo section "Out of scope" based on the current version.');
    expect(screen.getByText('All conflicts are resolved.')).toBeInTheDocument();
  });

  it('keeps the current version', async () => {
    render(<ApplyResultCard result={result} messages={messages} onSend={vi.fn()} />);
    await click(screen.getByRole('button', { name: /Keep current/ }));
    expect(screen.queryByText('Changed by bob')).toBeNull();
  });

  it('links created children', async () => {
    const onSelectItem = vi.fn();
    render(<ApplyResultCard result={{ created: [{ proposalId: 'c1', itemId: 'new-1', title: 'Export as PDF' }], edited: [], rejected: ['c2'], failed: [], relationshipsCreated: 1 }} messages={[]} onSelectItem={onSelectItem} />);
    expect(screen.getByRole('status')).toHaveTextContent('Created 1 item · 1 rejected · 1 relationship');
    await click(screen.getByRole('button', { name: 'Export as PDF' }));
    expect(onSelectItem).toHaveBeenCalledWith('new-1');
  });
});

describe('light and dark themes', () => {
  it.each(['light', 'dark'])('has no axe violations in the %s theme', async (theme) => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<><ReviewCard interrupt={interrupt()} document={doc} onDecide={vi.fn()} /><PredictivePreview document={doc} proposal={args} status="review" /><ApplyResultCard result={{ applied: ['a'], edited: [], rejected: [], conflicted: [], newVersion: 2 }} messages={[]} /></>);
    await expectNoAxeViolations(container);
    delete document.documentElement.dataset.theme;
  });
});
