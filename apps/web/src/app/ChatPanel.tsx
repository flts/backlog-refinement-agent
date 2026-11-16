import React, { useEffect, useRef, useState } from 'react';
import type { BacklogItem } from '../domain/backlog-item';
import type { AssessmentProposal, DecompositionProposal } from '../domain/proposal';
import type { RefinementSession } from '../domain/refinement-session';
import { Composer } from './Composer';
import { ProposalPanel } from './ProposalPanel';
import { ReviewPanel } from './ReviewPanel';
import { formatTime, itemTypeLabel } from './labels';

export type ChatPanelProps = {
  className: string;
  item?: BacklogItem;
  parentItem?: BacklogItem;
  session?: RefinementSession;
  sessions: RefinementSession[];
  busy: boolean;
  canRetry: boolean;
  message: string;
  reviewChanges: boolean;
  pending?: { sessionId: string; proposal: AssessmentProposal };
  proposal?: DecompositionProposal;
  selectedProposals: string[];
  onSelectItem: (id: string) => void;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: () => void;
  onMessageChange: (value: string) => void;
  onSubmit: () => void;
  onContinue: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onToggleReview: (enabled: boolean) => void;
  onApplyPending: () => void;
  onDiscardPending: () => void;
  onProposalChange: (proposal: DecompositionProposal) => void;
  onSelectedProposalsChange: (ids: string[]) => void;
  onAcceptProposals: () => void;
  onDismissProposal: () => void;
  onCreateItem: () => void;
};

export function ChatPanel(props: ChatPanelProps) {
  const { className, item, parentItem, session, sessions, busy, canRetry, message, reviewChanges, pending, proposal, selectedProposals,
    onSelectItem, onNewSession, onSwitchSession, onDeleteSession, onMessageChange, onSubmit, onContinue, onCancel, onRetry, onToggleReview, onApplyPending,
    onDiscardPending, onProposalChange, onSelectedProposalsChange, onAcceptProposals, onDismissProposal, onCreateItem } = props;
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const messages = session?.conversation ?? [];
  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || (!busy && messages.length === 0)) return;
    const frame = requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [busy, messages.length, item?.id]);
  const [announcement, setAnnouncement] = useState('');
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (busy && !wasBusy.current) setAnnouncement('Refinement agent is responding…');
    else if (!busy && wasBusy.current) setAnnouncement('Refinement agent finished responding.');
    wasBusy.current = busy;
  }, [busy]);

  return (
    <section className={className} aria-label="Refinement workspace">
      {item ? <>
        <div className="refine-heading">
          <div>
            <h2 className="eyebrow">Refinement workspace</h2>
          </div>
          <div className="heading-actions">
            <label className="session-picker">
              <span>Session</span>
              <select className="session-select" aria-label="Choose refinement session" value={session?.id ?? ''} disabled={busy || !session} onChange={(event) => onSwitchSession(event.target.value)}>
                {!session && <option value="">Loading…</option>}
                {sessions.map((savedSession, index) => <option key={savedSession.id} value={savedSession.id}>Session {sessions.length - index} · {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(savedSession.updatedAt))}</option>)}
              </select>
            </label>
            <button className="new-session-button" disabled={busy || !session} onClick={onNewSession} aria-label="Start a new refinement session" title="New refinement session"><span aria-hidden="true">＋</span></button>
            <button className="new-session-button" disabled={busy || !session} onClick={onDeleteSession} aria-label="Delete refinement session" title="Delete refinement session"><span aria-hidden="true">×</span></button>
          </div>
        </div>
        <p className="sr-only" role="status">{announcement}</p>
        <div ref={conversationRef} className="conversation-scroll" role="log" aria-label="Conversation" tabIndex={0}>
          {messages.length === 0 && <div className="welcome-card"><div className="agent-icon" aria-hidden="true">✳</div><div><strong>Let’s make this item clear and useful.</strong><p>Share what you know. I’ll help identify what’s missing, keep assumptions visible, and shape the work without inventing requirements.</p><div className="welcome-prompt"><span aria-hidden="true">↳</span> What outcome should this work make possible?</div></div></div>}
          {messages.map((entry) => <div key={entry.id} className={`message-row ${entry.role === 'user' ? 'message-user' : ''}`}><div className={entry.role === 'user' ? 'user-avatar' : 'agent-icon'} aria-hidden="true">{entry.role === 'user' ? 'F' : '✳'}</div><div className="message-content"><span className="message-author">{entry.role === 'user' ? 'You' : 'Refinement agent'} <time>{formatTime(entry.createdAt)}</time></span><p>{entry.content}</p></div></div>)}
          {busy && <div className="message-row"><div className="agent-icon" aria-hidden="true">✳</div><div className="message-content"><span className="message-author">Refinement agent</span><p className="typing"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>Thinking through the details</span></p></div></div>}
          {pending && pending.sessionId === session?.id && <ReviewPanel currentDescription={item.description} proposal={pending.proposal} busy={busy} onApply={onApplyPending} onDiscard={onDiscardPending} />}
          {proposal && <ProposalPanel proposal={proposal} selected={selectedProposals} busy={busy} onChange={onProposalChange} onSelectedChange={onSelectedProposalsChange} onAccept={onAcceptProposals} onDismiss={onDismissProposal} />}
        </div>
        <div className="composer-wrap">
          <div className="composer-tools">
            <span><span className="green-spark" aria-hidden="true">✳</span> Refine with AI</span>
            <span className="composer-hint">Enter to send · Shift+Enter for new line</span>
          </div>
          <Composer value={message} busy={busy} onChange={onMessageChange} onSubmit={onSubmit} />
          <div className="composer-actions">
            {busy && <button className="retry-button" onClick={onCancel}><span aria-hidden="true">■</span> Cancel request</button>}
            {canRetry && <button className="retry-button" onClick={onRetry} disabled={busy}><span aria-hidden="true">↻</span> Retry last request</button>}
            <button className="continue-button" title="Stop asking and capture what’s still unknown" onClick={onContinue} disabled={busy || !session}><span aria-hidden="true">◷</span> Continue with current information</button>
            <label className="composer-hint review-toggle"><input type="checkbox" checked={reviewChanges} onChange={(event) => onToggleReview(event.target.checked)} /> Review changes before applying</label>
          </div>
        </div>
      </> : <div className="no-selection">
        <div className="empty-icon" aria-hidden="true">✳</div>
          <h2>Choose what to refine</h2>
          <p>Select an item from your backlog or create something new.</p>
          <button className="button button-primary" onClick={onCreateItem}>Create backlog item</button>
        </div>}
    </section>
  );
}
