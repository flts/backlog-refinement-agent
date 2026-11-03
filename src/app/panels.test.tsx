import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewPanel } from './ReviewPanel';
import { ProposalPanel } from './ProposalPanel';
import type { AssessmentProposal, DecompositionProposal } from '../domain/proposal';

describe('ReviewPanel', () => {
  const proposal = {
    summary: 'Added a goal.',
    sectionUpdates: [{ heading: 'Goal', markdown: 'Ship faster', mode: 'replace' }],
  } as unknown as AssessmentProposal;

  it('shows the diff and lets the user apply or discard', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    render(<ReviewPanel currentDescription={'## Goal\nOld goal'} proposal={proposal} busy={false} onApply={onApply} onDiscard={onDiscard} />);
    expect(screen.getByText('+ Ship faster')).toBeInTheDocument();
    expect(screen.getByText('− Old goal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Apply changes/ }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});

describe('ProposalPanel', () => {
  const proposal = {
    kind: 'decomposition', parentItemId: 'p', rationale: 'Split it.', relationships: [],
    children: [{ proposalId: 'c1', type: 'feature', title: 'Child', description: '## Goal\nx\n\n## Assumptions\n- [ ] a' }],
  } as unknown as DecompositionProposal;

  it('reports counts and accepts the selection', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    render(<ProposalPanel proposal={proposal} selected={['c1']} busy={false} onChange={vi.fn()} onSelectedChange={vi.fn()} onAccept={onAccept} onDismiss={vi.fn()} />);
    expect(screen.getByText(/1 assumptions · 0 open questions/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add selected items/ }));
    expect(onAccept).toHaveBeenCalledOnce();
  });
});
