import { useState } from 'react';
import type { ItemStatus, ItemType } from '../api';
import type { AssessmentProposal, DecompositionProposal } from '../domain/proposal';
import type { Backlog } from './useBacklog';
import type { Notifications } from './useNotifications';

export const agentNotConnectedNotice = 'The agent is being connected';

/**
 * Temporary stand-in while the AG-UI agent connection is built (todo `fe-run-orchestration` replaces this hook).
 * There is no in-browser LLM any more: actions that need the agent only show a non-blocking notice.
 * Refinement sessions are in memory only; they move to agent-service threads.
 */
export function useRefinementFlow(backlog: Pick<Backlog, 'selectedItem' | 'changeStatus' | 'undoLastChange'>, { setError, setNotice }: Pick<Notifications, 'setError' | 'setNotice'>) {
  const { selectedItem, changeStatus, undoLastChange } = backlog;
  const [message, setMessage] = useState('');
  const [proposal, setProposal] = useState<DecompositionProposal>();
  const [reviewChanges, setReviewChanges] = useState(false);
  const [selectedProposals, setSelectedProposals] = useState<string[]>([]);
  const busy = false;
  const retryState = undefined as { sessionId: string; force: boolean } | undefined;
  const pending = undefined as { sessionId: string; proposal: AssessmentProposal; force: boolean } | undefined;

  function reset() {
    setMessage(''); setProposal(undefined);
  }

  function notConnected() {
    setError('');
    setNotice(agentNotConnectedNotice);
  }

  async function changeSelectedStatus(status: ItemStatus) {
    if (!selectedItem) return;
    if (selectedItem.status === 'draft' && status === 'ready' && !(await changeStatus('refining'))) return;
    await changeStatus(status);
  }

  return {
    message, setMessage, busy, retryState, proposal, setProposal, reviewChanges, pending, selectedProposals, setSelectedProposals,
    reset, toggleReview: setReviewChanges, changeSelectedStatus, undoLastChange: () => { void undoLastChange(); },
    cancelRequest: () => undefined,
    submitMessage: (_force = false) => { notConnected(); return Promise.resolve(); },
    retryAssessment: () => { notConnected(); return Promise.resolve(); },
    proposeChildren: (_type: ItemType) => { notConnected(); return Promise.resolve(); },
    assessQuality: () => { notConnected(); return Promise.resolve(); },
    applyPending: () => Promise.resolve(),
    discardPending: () => Promise.resolve(),
    acceptSelectedProposals: () => Promise.resolve(),
  };
}
