import React, { useEffect, useRef } from 'react';
import type { Item, ItemSummary } from '../api';
import type { FeedbackRating, ResumeDecision, Thread } from '../agent';
import type { AskUserResult, NextAction } from '../contracts';
import type { RunState } from '../run';
import { ContextBar } from '../context/ContextBar';
import type { MentionCandidate } from '../context/mentions';
import type { AgentCommandEntry } from '../palette/commands';
import { useRunAnnouncements } from './announcements';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { AskUserCard, AskUserInvalidNotice } from '../askuser';
import { ApplyResultCard, ReviewPanel, useResultVisibility } from '../review';
import { SessionTitle } from './SessionTitle';
import { SuggestionChips } from './SuggestionChips';
import { ThreadPicker } from './ThreadPicker';

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
  onRenameThread: (id: string, title: string) => Promise<unknown>;
  onDeleteThread: (id: string) => Promise<unknown>;
  onMessageChange: (value: string) => void;
  onSubmit: () => void;
  onContinue: () => void;
  onStop: () => void;
  onRetry: () => void;
  /** Expired proposal: re-propose keeping the user's edits (`run.repropose()`). */
  onRepropose?: () => void;
  /** The validated answer of the `ask_user` card (`useAgentRun().answer`). */
  onAnswer: (result: AskUserResult) => void;
  /** Placeholder for the ReviewCard (fe-review-ui): approves or rejects every pending proposal. */
  onDecideAll: (approved: boolean) => void;
  onCreateItem: () => void;
  /** A next-step chip was chosen (`message` → send its prompt, other intents → continue with that intent). */
  onSuggestion?: (action: NextAction) => void;
  /** Rates an assistant message of the active thread. */
  onFeedback?: (messageId: string, rating: FeedbackRating, comment?: string) => Promise<unknown>;
  /** Shows the context bar above the composer for this project (context/). */
  projectId?: string;
  /** Composer `/` menu (palette/commands.ts) and its handler. */
  slashCommands?: readonly AgentCommandEntry[];
  onSlashCommand?: (command: AgentCommandEntry) => void;
  /** Items the composer `@` picker offers; the current item is left out. */
  mentionItems?: readonly MentionCandidate[];
  /** ReviewCard: one decision per pending proposal (`run.decide`). Falls back to `onDecideAll` (approve everything / reject everything). */
  onDecide?: (decisions: ResumeDecision[]) => void;
  /** Sends a chat message (conflict resolution: "Please redo section …"). */
  onSend?: (text: string) => void;
};

/**
 * When the ask_user / review card is answered it unmounts together with the focused control, which would drop focus on
 * <body>. Hand focus on to the composer (or the conversation log while the composer is disabled).
 */
function useRestoreFocusAfterCard(hasCard: boolean, root: React.RefObject<HTMLElement | null>) {
  const previous = useRef(hasCard);
  useEffect(() => {
    const before = previous.current;
    previous.current = hasCard;
    if (!before || hasCard) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = root.current?.querySelector<HTMLElement>('textarea:not(:disabled)') ?? root.current?.querySelector<HTMLElement>('.conversation-scroll');
    target?.focus({ preventScroll: true });
  }, [hasCard, root]);
}

export function ChatPanel(props: ChatPanelProps) {
  const { className, item, threads, activeThreadId, run, busy, canRetry, message,
    onNewThread, onSelectThread, onRenameThread, onDeleteThread, onMessageChange, onSubmit, onContinue, onStop, onRetry, onAnswer, onDecideAll, onCreateItem, onSuggestion, onFeedback, projectId, slashCommands, onSlashCommand, mentionItems, onDecide, onSend } = props;
  const reviewing = run.phase === 'awaitingReview' && run.interrupts.some((interrupt) => !interrupt.expired);
  const lastApply = run.agentState.lastApply;
  const userMessages = run.messages.filter((entry) => entry.kind === 'user').length;
  const showResult = useResultVisibility(lastApply, userMessages) && !reviewing && run.phase !== 'running';
  const running = run.phase === 'running';
  const hydrating = run.phase === 'hydrating';
  const announcements = useRunAnnouncements(run);
  const section = useRef<HTMLElement>(null);
  const expiredShown = run.interrupts.some((interrupt) => interrupt.expired);
  useRestoreFocusAfterCard(run.phase === 'awaitingInput' || run.phase === 'awaitingReview' || expiredShown, section);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const asking = run.phase === 'awaitingInput' && Boolean(run.pendingAskUser?.args);
  const reason = running ? 'The agent is working. Press Esc to stop it.' : hydrating ? 'Loading the conversation…' : undefined;

  return (
    <section ref={section} className={className} aria-label="Refinement workspace">
      {item ? <>
        <div className="refine-heading">
          <div>
            <h2 className="eyebrow">Refinement workspace</h2>
            <SessionTitle thread={activeThread} disabled={busy} onRename={onRenameThread} />
          </div>
          <div className="heading-actions">
            <ThreadPicker threads={threads} activeThreadId={activeThreadId} disabled={busy} onSelect={onSelectThread} onCreate={onNewThread} onRename={onRenameThread} onDelete={onDeleteThread} />
          </div>
        </div>
        <p className="sr-only" role="status">{announcements.polite}</p>
        <p className="sr-only" role="alert">{announcements.assertive}</p>
        {run.messages.length === 0 && !hydrating && run.phase !== 'running' && (
          <div className="welcome-card"><div className="agent-icon" aria-hidden="true">✳</div><div><strong>Let’s make this item clear and useful.</strong><p>Share what you know. I’ll help identify what’s missing, keep assumptions visible, and shape the work without inventing requirements.</p><div className="welcome-prompt"><span aria-hidden="true">↳</span> What outcome should this work make possible?</div></div></div>
        )}
        <MessageList run={run} canRetry={canRetry} busy={busy} onRetry={onRetry} resetKey={`${item.id}:${activeThreadId ?? ''}`} onFeedback={onFeedback}>
          {run.phase === 'awaitingInput' && run.pendingAskUser?.args && <AskUserCard key={run.pendingAskUser.toolCallId} args={run.pendingAskUser.args} disabled={busy} onAnswer={onAnswer} />}
          {run.phase === 'awaitingInput' && run.pendingAskUser && !run.pendingAskUser.args && <AskUserInvalidNotice />}
          {run.phase === 'idle' && onSuggestion && <SuggestionChips actions={run.agentState.nextActions} disabled={busy} onSelect={onSuggestion} />}
          {(reviewing || expiredShown) && (
            <ReviewPanel run={run} document={item.document} itemId={item.id} disabled={busy} onSelectItem={props.onSelectItem}
              onDecide={onDecide ?? ((decisions) => onDecideAll(decisions.every((decision) => 'approved' in decision && decision.approved)))} onRetry={onRetry} onRepropose={props.onRepropose} />
          )}
          {showResult && lastApply && <ApplyResultCard result={lastApply} messages={run.messages} disabled={busy} onSend={onSend} onSelectItem={props.onSelectItem} />}
        </MessageList>
        <div className="composer-wrap">
          {projectId && <ContextBar projectId={projectId} item={item} onSelectItem={props.onSelectItem} />}
          <div className="composer-tools">
            <span><span className="green-spark" aria-hidden="true">✳</span> Refine with AI</span>
            <span className="composer-hint">Enter to send · Shift+Enter for new line · / commands · @ items</span>
          </div>
          {reviewing && <p className="composer-note" role="note">Sending a message cancels the pending proposal.</p>}
          <Composer value={message} busy={busy} running={running} reason={reason} asking={asking} onChange={onMessageChange} onSubmit={onSubmit} onStop={onStop} slashCommands={slashCommands} onSlashCommand={onSlashCommand} mentionItems={mentionItems} />
          <div className="composer-actions">
            {running && <button className="retry-button" onClick={onStop}><span aria-hidden="true">■</span> Stop <span className="composer-hint">(Esc)</span></button>}
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
