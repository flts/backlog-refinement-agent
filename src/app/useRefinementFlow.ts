import { useRef, useState } from 'react';
import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';
import type { PendingQuestion } from '../domain/refinement-session';
import type { AssessmentProposal, DecompositionProposal } from '../domain/proposal';
import type { RefinementApplicationService } from '../application/refinement-service';
import { logError } from '../infrastructure/logging';
import { itemTypeLabel } from './labels';
import { workspace } from './services';
import { errorText, type Notifications } from './useNotifications';
import type { Backlog } from './useBacklog';

export function useRefinementFlow(backlog: Backlog, refinement: RefinementApplicationService, { setError, setNotice }: Notifications) {
  const { selectedItem, session, setItems, setSession, updateSelected, refresh } = backlog;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryState, setRetryState] = useState<{ sessionId: string; force: boolean }>();
  const [proposal, setProposal] = useState<DecompositionProposal>();
  const [reviewChanges, setReviewChanges] = useState(() => localStorage.getItem('review-ai-changes') === '1');
  const [pending, setPending] = useState<{ sessionId: string; proposal: AssessmentProposal; force: boolean }>();
  const [selectedProposals, setSelectedProposals] = useState<string[]>([]);
  const abortRef = useRef<AbortController | undefined>(undefined);

  function reset() {
    setMessage(''); setProposal(undefined); setPending(undefined); setRetryState(undefined);
  }

  function startRequest(): AbortSignal {
    const controller = new AbortController();
    abortRef.current = controller;
    return controller.signal;
  }

  function cancelRequest() {
    abortRef.current?.abort();
  }

  async function changeSelectedStatus(status: BacklogItem['status']) {
    if (!selectedItem || !session) return;
    try {
      if (selectedItem.status === 'draft' && status === 'ready') {
        const refiningItem = await refinement.beginRefinement(session.id);
        setItems((current) => current.map((item) => item.id === refiningItem.id ? refiningItem : item));
      }
      await updateSelected({ status });
    } catch (cause) { setError(`Could not change status: ${errorText(cause)}`); }
  }

  async function finalizeAssessment(sessionId: string, response: AssessmentProposal) {
    const [updated] = await refinement.acceptProposal(response);
    if (refinement.lastWarnings.length) setNotice(refinement.lastWarnings.join(' '));
    const agentText = response.questions.length
      ? `${response.summary}\n\n${response.questions.map((question) => `• ${question.text}`).join('\n')}`
      : response.summary;
    const pendingQuestions: PendingQuestion[] = response.questions.map(({ id, text, importance, relatedField, rationale }) => ({ id, text, importance, relatedField, rationale }));
    const savedSession = await workspace.addAgentMessage(sessionId, agentText, pendingQuestions);
    setSession(savedSession);
    const finished = { ...updated, status: response.suggestedStatus ?? updated.status };
    setItems((current) => current.map((item) => item.id === finished.id ? finished : item));
  }

  async function applyPending() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      await finalizeAssessment(pending.sessionId, pending.proposal);
      if (pending.force) await workspace.setForceGeneration(pending.sessionId, false);
      setPending(undefined);
    } catch (cause) { setError(`Could not apply changes: ${errorText(cause)}`); }
    finally { setBusy(false); }
  }

  async function discardPending() {
    if (!pending) return;
    if (pending.force) await workspace.setForceGeneration(pending.sessionId, false).catch(() => undefined);
    setPending(undefined);
    setNotice('Proposed changes discarded. Your message stays in the conversation.');
  }

  function toggleReview(enabled: boolean) {
    setReviewChanges(enabled);
    localStorage.setItem('review-ai-changes', enabled ? '1' : '0');
  }

  async function submitMessage(force = false) {
    if (!session || !selectedItem || busy || (!message.trim() && !force)) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    let messageSaved = false;
    const humanText = force ? 'Continue with the current information. Do not ask more questions; capture uncertainty as open questions.' : message.trim();
    try {
      const currentItem = await refinement.beginRefinement(session.id);
      setItems((current) => current.map((item) => item.id === currentItem.id ? currentItem : item));
      let currentSession = await refinement.recordHumanMessage(session.id, humanText);
      messageSaved = true;
      setSession(currentSession);
      if (!force) setMessage('');
      if (force) currentSession = await workspace.setForceGeneration(session.id, true);
      const response = await refinement.proposeAssessment(currentSession.id, signal);
      if (response.kind !== 'assessment') throw new Error('The model returned the wrong response type.');
      if (reviewChanges) {
        setPending({ sessionId: currentSession.id, proposal: response, force });
        setRetryState(undefined);
        setNotice('Review the proposed changes before they are applied.');
        return;
      }
      await finalizeAssessment(currentSession.id, response);
      setRetryState(undefined);
      if (force) {
        await workspace.setForceGeneration(session.id, false);
        setNotice('Refinement finished with the information available. Review remaining questions in the item preview.');
      }
    } catch (cause) {
      let resetFailure = '';
      if (force) {
        try { await workspace.setForceGeneration(session.id, false); }
        catch (resetError) { resetFailure = ` The generation flag could not be reset: ${errorText(resetError)}`; }
      }
      setRetryState(messageSaved ? { sessionId: session.id, force } : undefined);
      if (signal.aborted) {
        setNotice('Request cancelled. Your message is saved; retry when ready.');
        return;
      }
      setError(`${errorText(cause)}${resetFailure} ${messageSaved ? 'Your message is saved; retry the request.' : force ? 'No request was sent because the session could not be saved.' : 'Your message remains in the composer.'}`);
    } finally { setBusy(false); }
  }

  async function retryAssessment() {
    if (!retryState || !session || !selectedItem || busy) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    try {
      await refinement.beginRefinement(retryState.sessionId);
      if (retryState.force) await workspace.setForceGeneration(retryState.sessionId, true);
      const response = await refinement.proposeAssessment(retryState.sessionId, signal);
      if (response.kind !== 'assessment') throw new Error('The model returned the wrong response type.');
      if (reviewChanges) {
        setPending({ sessionId: retryState.sessionId, proposal: response, force: retryState.force });
        setRetryState(undefined);
        setNotice('Review the proposed changes before they are applied.');
        return;
      }
      await finalizeAssessment(retryState.sessionId, response);
      if (retryState.force) await workspace.setForceGeneration(retryState.sessionId, false);
      setRetryState(undefined);
      setNotice('Refinement response received.');
    } catch (cause) {
      if (retryState.force) await workspace.setForceGeneration(retryState.sessionId, false).catch(() => undefined);
      if (signal.aborted) setNotice('Request cancelled.');
      else setError(`Retry failed: ${errorText(cause)}`);
    } finally { setBusy(false); }
  }

  async function proposeChildren(type: BacklogItemType) {
    if (!selectedItem || !session) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    try {
      const generated = await refinement.proposeDecomposition(session.id, signal, type);
      if (generated.kind !== 'decomposition') throw new Error('The model returned the wrong response type.');
      const children = generated.children.filter((child) => child.type === type);
      const refs = new Set([generated.parentItemId, ...children.map((child) => child.proposalId)]);
      const filtered: DecompositionProposal = {
        ...generated,
        children,
        relationships: generated.relationships.filter((relationship) =>
          refs.has(relationship.sourceRef) && refs.has(relationship.targetRef)),
      };
      if (!filtered.children.length) {
        setNotice(`No ${itemTypeLabel[type].toLowerCase()} proposals suggested. ${generated.rationale}`);
        return;
      }
      setProposal(filtered);
      setSelectedProposals(filtered.children.map((child) => child.proposalId));
    } catch (cause) {
      if (signal.aborted) setNotice('Request cancelled.');
      else setError(`Could not propose children: ${errorText(cause)}`);
    }
    finally { setBusy(false); }
  }

  async function acceptSelectedProposals() {
    if (!proposal || !selectedProposals.length) return;
    setBusy(true); setError('');
    try {
      const created = await refinement.acceptProposal(proposal, selectedProposals);
      setProposal(undefined);
      await refresh(created[0]?.id);
      setNotice(`${created.length} child ${created.length === 1 ? 'item' : 'items'} added to the backlog`);
    } catch (cause) { setError(`Could not accept proposals: ${errorText(cause)}`); }
    finally { setBusy(false); }
  }

  async function assessQuality() {
    if (!selectedItem || busy) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    try {
      const updated = await refinement.assessQuality(selectedItem.id, signal);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice('Quality assessment updated.');
    } catch (cause) {
      logError('Quality assessment failed', cause);
      if (signal.aborted) setNotice('Request cancelled.');
      else setError(`Could not assess quality: ${errorText(cause)}`);
    } finally { setBusy(false); }
  }

  async function undoLastChange() {
    if (!selectedItem) return;
    try {
      const restored = await refinement.undoLastChange(selectedItem.id);
      setItems((current) => current.map((item) => item.id === restored.id ? restored : item));
      setNotice('Restored the version before the last AI change.');
    } catch (cause) { logError('Could not undo', cause); setError(`Could not undo: ${errorText(cause)}`); }
  }

  return {
    message, setMessage, busy, retryState, proposal, setProposal, reviewChanges, pending, selectedProposals, setSelectedProposals,
    reset, cancelRequest, changeSelectedStatus, applyPending, discardPending, toggleReview, submitMessage, retryAssessment,
    proposeChildren, acceptSelectedProposals, assessQuality, undoLastChange,
  };
}
