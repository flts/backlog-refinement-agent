import React from 'react';
import type { Item, ItemSummary } from '../api';
import type { Thread } from '../agent';
import type { AskUserResult } from '../contracts';
import type { RunState } from '../run';
import { useRunAnnouncements } from './announcements';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { AskUserCard, AskUserInvalidNotice } from '../askuser';
import { ReviewPlaceholder } from './placeholders';
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
  /** The validated answer of the `ask_user` card (`useAgentRun().answer`). */
  onAnswer: (result: AskUserResult) => void;
  /** Placeholder for the ReviewCard (fe-review-ui): approves or rejects every pending proposal. */
  onDecideAll: (approved: boolean) => void;
  onCreateItem: () => void;
};

export function ChatPanel(props: ChatPanelProps) {
  const { className, item, threads, activeThreadId, run, busy, canRetry, message,
    onNewThread, onSelectThread, onRenameThread, onDeleteThread, onMessageChange, onSubmit, onContinue, onStop, onRetry, onAnswer, onDecideAll, onCreateItem } = props;
  const running = run.phase === 'running';
  const hydrating = run.phase === 'hydrating';
  const announcements = useRunAnnouncements(run);
  const asking = run.phase === 'awaitingInput' && Boolean(run.pendingAskUser?.args);
  const reason = running ? 'The agent is working. Press Esc to stop it.' : hydrating ? 'Loading the conversation…' : undefined;

  return (
    <section className={className} aria-label="Refinement workspace">
      {item ? <>
        <div className="refine-heading">
          <div>
            <h2 className="eyebrow">Refinement workspace</h2>
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
        <MessageList run={run} canRetry={canRetry} busy={busy} onRetry={onRetry} resetKey={`${item.id}:${activeThreadId ?? ''}`}>
          {run.phase === 'awaitingInput' && run.pendingAskUser?.args && <AskUserCard key={run.pendingAskUser.toolCallId} args={run.pendingAskUser.args} disabled={busy} onAnswer={onAnswer} />}
          {run.phase === 'awaitingInput' && run.pendingAskUser && !run.pendingAskUser.args && <AskUserInvalidNotice />}
          {run.phase === 'awaitingReview' && <ReviewPlaceholder run={run} disabled={busy} onDecideAll={onDecideAll} />}
        </MessageList>
        <div className="composer-wrap">
          <div className="composer-tools">
            <span><span className="green-spark" aria-hidden="true">✳</span> Refine with AI</span>
            <span className="composer-hint">Enter to send · Shift+Enter for new line</span>
          </div>
          <Composer value={message} busy={busy} running={running} reason={reason} asking={asking} onChange={onMessageChange} onSubmit={onSubmit} onStop={onStop} />
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
