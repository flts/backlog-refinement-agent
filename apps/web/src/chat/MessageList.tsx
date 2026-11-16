import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AskUserTranscriptEntry, showsAskUserSummary } from '../askuser';
import { ASK_USER_TOOL_NAME } from '../contracts';
import type { RunState, TranscriptEntry } from '../run';
import { ActivityTimeline } from './ActivityTimeline';
import { isActivityEntry, type ActivityRowEntry } from './activity';
import { MarkdownMessage } from './MarkdownMessage';
import { RunErrorCard } from './RunErrorCard';

export interface MessageListProps {
  run: Pick<RunState, 'phase' | 'messages'>;
  /** The latest error can be retried. */
  canRetry?: boolean;
  busy?: boolean;
  onRetry?: () => void;
  /** Cards that belong at the end of the conversation (ask-user, review). */
  children?: ReactNode;
  /** Changes when another conversation opens: scrolls to the end again. */
  resetKey?: string;
}

type Block =
  | { kind: 'message'; entry: Extract<TranscriptEntry, { kind: 'user' | 'assistant' }> }
  | { kind: 'activity'; id: string; entries: ActivityRowEntry[] }
  | { kind: 'error'; entry: Extract<TranscriptEntry, { kind: 'error' }> }
  | { kind: 'askUser'; entry: Extract<TranscriptEntry, { kind: 'tool' }> };

/** Consecutive steps and tool calls form one timeline; tools with their own UI (ask_user, …) are left out. */
export function buildBlocks(messages: TranscriptEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const entry of messages) {
    if (entry.kind === 'user' || entry.kind === 'assistant') {
      if (entry.kind === 'assistant' && !entry.text && !entry.streaming) continue;
      blocks.push({ kind: 'message', entry });
    } else if (entry.kind === 'error') {
      blocks.push({ kind: 'error', entry });
    } else if (entry.kind === 'tool' && entry.toolName === ASK_USER_TOOL_NAME) {
      if (showsAskUserSummary(entry)) blocks.push({ kind: 'askUser', entry });
    } else if (isActivityEntry(entry)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'activity') last.entries.push(entry);
      else blocks.push({ kind: 'activity', id: entry.id, entries: [entry] });
    }
  }
  return blocks;
}

const NEAR_BOTTOM = 48;

export function MessageList({ run, canRetry = false, busy = false, onRetry, children, resetKey }: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const blocks = buildBlocks(run.messages);
  const streaming = run.messages.some((entry) => entry.kind === 'assistant' && entry.streaming);
  const working = run.phase === 'running' && !streaming && !run.messages.some((entry) => (entry.kind === 'tool' || entry.kind === 'step') && entry.status === 'running');
  const lastError = [...run.messages].reverse().find((entry) => entry.kind === 'error');
  const size = run.messages.reduce((total, entry) => total + (entry.kind === 'assistant' ? entry.text.length : 1), 0);

  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    stuck.current = true;
    setAway(false);
  }, []);

  useLayoutEffect(() => { toBottom(); }, [resetKey, toBottom]);
  useLayoutEffect(() => {
    if (stuck.current) toBottom();
    else setAway(true);
  }, [size, run.phase, toBottom]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (stuck.current) element.scrollTop = element.scrollHeight; });
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [blocks.length]);

  function onScroll() {
    const element = scroller.current!;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM;
    stuck.current = near;
    if (near) setAway(false);
  }

  return (
    <div className="conversation-wrap">
      <div ref={scroller} className="conversation-scroll" role="log" aria-live="off" aria-label="Conversation" aria-busy={run.phase === 'hydrating' || undefined} tabIndex={0} onScroll={onScroll}>
        {run.phase === 'hydrating' && (
          <div className="conversation-skeleton" data-testid="conversation-skeleton">
            <span className="sr-only">Loading the conversation…</span>
            <div aria-hidden="true"><i className="skeleton-line short" /><i className="skeleton-line" /><i className="skeleton-line" /><i className="skeleton-line short" /></div>
          </div>
        )}
        {blocks.map((block) => {
          if (block.kind === 'activity') return <ActivityTimeline key={`activity:${block.id}`} entries={block.entries} />;
          if (block.kind === 'askUser') return <AskUserTranscriptEntry key={`ask:${block.entry.id}`} entry={block.entry} />;
          if (block.kind === 'error') return <RunErrorCard key={block.entry.id} error={block.entry.error} canRetry={canRetry && block.entry === lastError} busy={busy} onRetry={block.entry === lastError ? onRetry : undefined} />;
          const { entry } = block;
          if (entry.kind === 'user') {
            return (
              <div key={entry.id} className="message-row message-user">
                <div className="user-avatar" aria-hidden="true">Y</div>
                <div className="message-content">
                  <span className="message-author">You</span>
                  <p>{entry.text}</p>
                  {entry.dismissed && <span className="message-note">Answered in chat</span>}
                </div>
              </div>
            );
          }
          return (
            <div key={entry.id} className="message-row">
              <div className="agent-icon" aria-hidden="true">✳</div>
              <div className="message-content">
                <span className="message-author">Refinement agent</span>
                <MarkdownMessage text={entry.text} streaming={entry.streaming} />
              </div>
            </div>
          );
        })}
        {working && <div className="message-row"><div className="agent-icon" aria-hidden="true">✳</div><div className="message-content"><span className="message-author">Refinement agent</span><p className="typing"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>Thinking through the details</span></p></div></div>}
        {children}
        {run.phase === 'cancelled' && <p className="muted-copy">Stopped.</p>}
      </div>
      {away && <button type="button" className="jump-latest button button-secondary button-small" onClick={toBottom}><span aria-hidden="true">↓</span> Jump to latest</button>}
    </div>
  );
}
