import React, { useEffect, useRef, useState } from 'react';
import type { Item, ItemSummary } from '../api';
import type { Thread } from '../agent';
import type { AskUserResult } from '../contracts';
import type { RunState } from '../run';
import { Composer } from './Composer';

export type ChatPanelProps = {
  className: string;
  item?: Item;
  parentItem?: ItemSummary;
  threads: Thread[];
  activeThreadId?: string;
  /** Reducer state of the active thread (`useAgentRun().state`). */
  run: RunState;
  busy: boolean;
  canRetry: boolean;
  message: string;
  onSelectItem: (id: string) => void;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: () => void;
  onMessageChange: (value: string) => void;
  onSubmit: () => void;
  onContinue: () => void;
  onStop: () => void;
  onRetry: () => void;
  /** Placeholder for the AskUserCard (fe-ask-user). */
  onAnswer: (result: AskUserResult) => void;
  /** Placeholder for the ReviewCard (fe-review-ui): approves or rejects every pending proposal. */
  onDecideAll: (approved: boolean) => void;
  onCreateItem: () => void;
};

const dateLabel = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));

/** Placeholder: the real card is built by fe-ask-user. One free-text answer per question. */
function AskUserPlaceholder({ run, disabled, onAnswer }: { run: RunState; disabled: boolean; onAnswer: (result: AskUserResult) => void }) {
  const questions = run.pendingAskUser?.args?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form className="proposal-panel" aria-label="The agent asks" onSubmit={(event) => {
      event.preventDefault();
      onAnswer({ status: 'answered', answers: questions.map((question) => {
        const freeform = answers[question.id]?.trim();
        return { questionId: question.id, selected: [], ...(freeform ? { freeform } : {}), skipped: !freeform };
      }) });
    }}>
      <div className="proposal-heading"><div><span className="eyebrow">Agent asks</span></div></div>
      {questions.map((question) => (
        <label key={question.id} className="proposal-copy">
          <span>{question.question}</span>
          <input value={answers[question.id] ?? ''} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} disabled={disabled} />
        </label>
      ))}
      <div className="proposal-actions">
        <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => onAnswer({ status: 'skipped', answers: questions.map((question) => ({ questionId: question.id, selected: [], skipped: true })) })}>Skip</button>
        <button type="submit" className="button button-primary button-small" disabled={disabled}>Answer</button>
      </div>
    </form>
  );
}

/** Placeholder: the real card is built by fe-review-ui. */
function ReviewPlaceholder({ run, disabled, onDecideAll }: { run: RunState; disabled: boolean; onDecideAll: (approved: boolean) => void }) {
  const live = run.interrupts.filter((interrupt) => !interrupt.expired);
  if (live.length === 0) return null;
  return (
    <div className="proposal-panel" role="region" aria-label="Review the agent’s proposal">
      <div className="proposal-heading"><div><span className="eyebrow">Agent proposes changes</span></div></div>
      {live.map((interrupt) => <p key={interrupt.id} className="proposal-rationale">{String(interrupt.args.summary ?? interrupt.args.rationale ?? interrupt.message ?? interrupt.toolName)}</p>)}
      <div className="proposal-actions">
        <button className="button button-secondary button-small" disabled={disabled} onClick={() => onDecideAll(false)}>Reject all</button>
        <button className="button button-primary button-small" disabled={disabled} onClick={() => onDecideAll(true)}>Approve all</button>
      </div>
    </div>
  );
}

export function ChatPanel(props: ChatPanelProps) {
  const { className, item, threads, activeThreadId, run, busy, canRetry, message,
    onNewThread, onSelectThread, onDeleteThread, onMessageChange, onSubmit, onContinue, onStop, onRetry, onAnswer, onDecideAll, onCreateItem } = props;
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const entries = run.messages;
  const running = run.phase === 'running';
  const activeWork = [...run.activity].reverse().find((entry) => entry.status === 'running');
  const lastLength = entries.reduce((total, entry) => total + (entry.kind === 'assistant' ? entry.text.length : 1), 0);
  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || (!running && entries.length === 0)) return;
    const frame = requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [running, lastLength, run.phase, item?.id]);
  const [announcement, setAnnouncement] = useState('');
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running && !wasRunning.current) setAnnouncement('Refinement agent is responding…');
    else if (!running && wasRunning.current) setAnnouncement('Refinement agent finished responding.');
    wasRunning.current = running;
  }, [running]);

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
              <select className="session-select" aria-label="Choose refinement session" value={activeThreadId ?? ''} disabled={running || threads.length === 0} onChange={(event) => onSelectThread(event.target.value)}>
                {threads.length === 0 && <option value="">New session</option>}
                {threads.map((thread, index) => <option key={thread.id} value={thread.id}>{thread.title || `Session ${threads.length - index}`} · {dateLabel(thread.updatedAt)}</option>)}
              </select>
            </label>
            <button className="new-session-button" disabled={running} onClick={onNewThread} aria-label="Start a new refinement session" title="New refinement session"><span aria-hidden="true">＋</span></button>
            <button className="new-session-button" disabled={running || !activeThreadId} onClick={onDeleteThread} aria-label="Delete refinement session" title="Delete refinement session"><span aria-hidden="true">×</span></button>
          </div>
        </div>
        <p className="sr-only" role="status">{announcement}</p>
        <div ref={conversationRef} className="conversation-scroll" role="log" aria-label="Conversation" tabIndex={0}>
          {entries.length === 0 && run.phase !== 'hydrating' && <div className="welcome-card"><div className="agent-icon" aria-hidden="true">✳</div><div><strong>Let’s make this item clear and useful.</strong><p>Share what you know. I’ll help identify what’s missing, keep assumptions visible, and shape the work without inventing requirements.</p><div className="welcome-prompt"><span aria-hidden="true">↳</span> What outcome should this work make possible?</div></div></div>}
          {run.phase === 'hydrating' && <p className="muted-copy" role="status">Loading the conversation…</p>}
          {entries.map((entry) => {
            if (entry.kind === 'user' || entry.kind === 'assistant') {
              const user = entry.kind === 'user';
              if (!entry.text && !user) return null;
              return <div key={entry.id} className={`message-row ${user ? 'message-user' : ''}`}><div className={user ? 'user-avatar' : 'agent-icon'} aria-hidden="true">{user ? 'Y' : '✳'}</div><div className="message-content"><span className="message-author">{user ? 'You' : 'Refinement agent'}</span><p>{entry.text}</p></div></div>;
            }
            if (entry.kind === 'error') {
              return (
                <div key={entry.id} className="proposal-panel" role="alert">
                  <p className="proposal-rationale">{entry.error.message}</p>
                  <p className="muted-copy">Code {entry.error.code}{entry.error.runId ? ` · run ${entry.error.runId}` : ''}</p>
                </div>
              );
            }
            return null;
          })}
          {running && <div className="message-row"><div className="agent-icon" aria-hidden="true">✳</div><div className="message-content"><span className="message-author">Refinement agent</span><p className="typing"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>{activeWork ? (activeWork.kind === 'step' ? activeWork.name : `Using ${activeWork.toolName}`) : 'Thinking through the details'}</span></p></div></div>}
          {run.phase === 'awaitingInput' && run.pendingAskUser?.args && <AskUserPlaceholder key={run.pendingAskUser.toolCallId} run={run} disabled={busy} onAnswer={onAnswer} />}
          {run.phase === 'awaitingReview' && <ReviewPlaceholder run={run} disabled={busy} onDecideAll={onDecideAll} />}
          {run.phase === 'cancelled' && <p className="muted-copy" role="status">Stopped.</p>}
        </div>
        <div className="composer-wrap">
          <div className="composer-tools">
            <span><span className="green-spark" aria-hidden="true">✳</span> Refine with AI</span>
            <span className="composer-hint">Enter to send · Shift+Enter for new line</span>
          </div>
          <Composer value={message} busy={busy} onChange={onMessageChange} onSubmit={onSubmit} />
          <div className="composer-actions">
            {running && <button className="retry-button" onClick={onStop}><span aria-hidden="true">■</span> Stop</button>}
            {canRetry && <button className="retry-button" onClick={onRetry} disabled={busy}><span aria-hidden="true">↻</span> {run.lastError?.proposalExpired ? 'Ask again' : 'Retry'}</button>}
            <button className="continue-button" title="Stop asking and capture what’s still unknown" onClick={onContinue} disabled={busy}><span aria-hidden="true">◷</span> Continue with current information</button>
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
