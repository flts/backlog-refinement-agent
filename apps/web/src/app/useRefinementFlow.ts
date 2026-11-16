import { useState } from 'react';
import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';
import type { AssessmentProposal, DecompositionProposal } from '../domain/proposal';
import { logError } from '../infrastructure/logging';
import { errorText, type Notifications } from './useNotifications';
import type { Backlog } from './useBacklog';

export const agentNotConnectedNotice = 'The agent is being connected';

/**
 * Temporary stand-in while the AG-UI agent connection is built (todo `fe-run-orchestration` replaces this hook).
 * There is no in-browser LLM any more: actions that need the agent only show a non-blocking notice.
 */
export function useRefinementFlow(backlog: Backlog, { setError, setNotice }: Notifications) {
  const { selectedItem, updateSelected } = backlog;
  const [message, setMessage] = useState('');
  const [proposal, setProposal] = useState<DecompositionProposal>();
  const [reviewChanges, setReviewChanges] = useState(() => localStorage.getItem('review-ai-changes') === '1');
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

  async function changeSelectedStatus(status: BacklogItem['status']) {
    if (!selectedItem) return;
    try {
      if (selectedItem.status === 'draft' && status === 'ready' && !(await updateSelected({ status: 'refining' }))) return;
      await updateSelected({ status });
    } catch (cause) { setError(`Could not change status: ${errorText(cause)}`); }
  }

  function toggleReview(enabled: boolean) {
    setReviewChanges(enabled);
    localStorage.setItem('review-ai-changes', enabled ? '1' : '0');
  }

  async function undoLastChange() {
    if (!selectedItem) return;
    const previous = selectedItem.revisions[selectedItem.revisions.length - 1];
    if (!previous) { setNotice('There is no earlier version to restore.'); return; }
    try {
      if (await updateSelected({ title: previous.title, description: previous.description, revisions: selectedItem.revisions.slice(0, -1) })) {
        setNotice('Restored the version before the last AI change.');
      }
    } catch (cause) { logError('Could not undo', cause); setError(`Could not undo: ${errorText(cause)}`); }
  }

  return {
    message, setMessage, busy, retryState, proposal, setProposal, reviewChanges, pending, selectedProposals, setSelectedProposals,
    reset, toggleReview, changeSelectedStatus, undoLastChange,
    cancelRequest: () => undefined,
    submitMessage: (_force = false) => { notConnected(); return Promise.resolve(); },
    retryAssessment: () => { notConnected(); return Promise.resolve(); },
    proposeChildren: (_type: BacklogItemType) => { notConnected(); return Promise.resolve(); },
    assessQuality: () => { notConnected(); return Promise.resolve(); },
    applyPending: () => Promise.resolve(),
    discardPending: () => Promise.resolve(),
    acceptSelectedProposals: () => Promise.resolve(),
  };
}
