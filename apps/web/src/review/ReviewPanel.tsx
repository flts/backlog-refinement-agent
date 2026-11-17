import { useEffect, useState } from 'react';
import type { ResumeDecision } from '../agent';
import { PROPOSE_CHILD_ITEMS_TOOL_NAME, PROPOSE_DOCUMENT_CHANGES_TOOL_NAME } from '../contracts';
import type { RunState } from '../run';
import { ChildProposalCard } from './ChildProposalCard';
import { similarItemsFrom } from './proposal';
import { ExpiredProposal } from './ExpiredProposal';
import { ReviewCard } from './ReviewCard';

export interface ReviewPanelProps {
  run: Pick<RunState, 'phase' | 'interrupts' | 'messages'>;
  /** Current document and id of the selected item. */
  document: string;
  itemId?: string;
  disabled?: boolean;
  /** Sends the decisions for ALL pending interrupts in one resume (`run.decide`). */
  onDecide: (decisions: ResumeDecision[]) => void;
  /** Expired proposals, "Start over": `run.retry()`. */
  onRetry: () => void;
  /** Expired proposals, "Ask the agent to re-propose with my edits": `run.repropose()`. */
  onRepropose?: () => void;
  onSelectItem?: (id: string) => void;
}

/**
 * The review cards of every pending interrupt. The server needs one resume entry per interrupt (spike #8), so with
 * several pending proposals the decisions are collected and sent together.
 */
export function ReviewPanel({ run, document, itemId, disabled = false, onDecide, onRetry, onRepropose, onSelectItem }: ReviewPanelProps) {
  const live = run.interrupts.filter((interrupt) => !interrupt.expired);
  const expired = run.interrupts.filter((interrupt) => interrupt.expired);
  const [collected, setCollected] = useState<Record<string, ResumeDecision>>({});
  const liveKey = live.map((interrupt) => interrupt.id).join(',');
  useEffect(() => setCollected({}), [liveKey]);

  if (run.phase === 'awaitingReview' && live.length > 0) {
    const similar = similarItemsFrom(run.messages, itemId);
    const decide = (decision: ResumeDecision) => {
      const next = { ...collected, [decisionId(decision)]: decision };
      if (live.every((interrupt) => next[interrupt.id])) onDecide(live.map((interrupt) => next[interrupt.id]));
      else setCollected(next);
    };
    return (
      <>
        {live.map((interrupt) => {
          const common = { interrupt, disabled, locked: Boolean(collected[interrupt.id]), similar, onSelectItem, onDecide: decide, onRetry };
          if (interrupt.toolName === PROPOSE_DOCUMENT_CHANGES_TOOL_NAME) return <ReviewCard key={interrupt.id} document={document} {...common} />;
          if (interrupt.toolName === PROPOSE_CHILD_ITEMS_TOOL_NAME) return <ChildProposalCard key={interrupt.id} parentItemId={itemId} {...common} />;
          return <UnknownProposal key={interrupt.id} name={interrupt.toolName} locked={common.locked} disabled={disabled} onDecide={decide} interruptId={interrupt.id} />;
        })}
      </>
    );
  }
  if (expired.length > 0) return <ExpiredProposal interrupts={expired} document={document} onRetry={onRetry} onRepropose={onRepropose} disabled={disabled} />;
  return null;
}

const decisionId = (decision: ResumeDecision) => decision.interruptId;

function UnknownProposal({ name, interruptId, locked, disabled, onDecide }: { name: string; interruptId: string; locked: boolean; disabled: boolean; onDecide: (decision: ResumeDecision) => void }) {
  return (
    <div className="proposal-panel review-card" role="region" aria-label="Approval needed">
      <p className="proposal-rationale">The agent wants to run “{name}”, which this app cannot preview. Reject it to continue safely.</p>
      <div className="proposal-actions"><span /><button type="button" className="button button-secondary button-small" disabled={disabled || locked} onClick={() => onDecide({ interruptId, approved: false })}>Reject</button></div>
    </div>
  );
}
