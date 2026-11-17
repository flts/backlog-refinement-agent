import { useEffect, useId, useRef } from 'react';
import { proposalExpiredReason, proposalExpiredTitle } from '../agent';
import { MarkdownMessage } from '../chat/MarkdownMessage';
import { buildRepromposeMessage, hasKeptContent, summarizeExpired, type ExpiredSummary } from '../run/reproposal';
import type { ReviewInterrupt } from '../run';
import { itemTypeLabel } from '../app/labels';
import type { ItemType } from '../contracts';
import { SectionDiff } from './SectionDiff';

export interface ExpiredProposalProps {
  /** The expired interrupts; their `draft` (the decision the user had made) is summarised read-only. */
  interrupts?: readonly ReviewInterrupt[];
  /** The current document, to diff the kept sections against. */
  document?: string;
  disabled?: boolean;
  /** "Ask the agent to re-propose …" (`run.repropose()`). */
  onRepropose?: () => void;
  /** "Start over" (`run.retry()`). */
  onRetry?: () => void;
  autoFocus?: boolean;
}

function Summary({ summary, document, headingId }: { summary: ExpiredSummary; document?: string; headingId: string }) {
  const childLabel = summary.childType ? itemTypeLabel[summary.childType as ItemType] ?? summary.childType : '';
  return (
    <div className="review-expired-summary">
      <h4 id={headingId}>{summary.kind === 'document' ? 'Changes you had accepted' : `${childLabel} items you had accepted`}: {summary.items.length} of {summary.total}</h4>
      <p className="review-rationale">The agent proposed: {summary.heading}</p>
      {(summary.title || summary.status) && (
        <ul className="review-expired-meta">
          {summary.title && <li>Rename the item to <strong>{summary.title}</strong></li>}
          {summary.status && <li>Set the status to <strong>{summary.status}</strong></li>}
        </ul>
      )}
      <ul className="review-sections" aria-labelledby={headingId}>
        {summary.items.map((item) => (
          <li key={item.id} className="review-section review-accepted">
            <details>
              <summary>
                <span className="review-expired-label">{item.label}</span>{' '}
                <span className="review-pill">{summary.kind === 'document' ? (item.kind === 'append' ? 'Append' : 'Replace') : childLabel}</span>{' '}
                <span className="review-pill review-state">{item.edited ? 'Edited by you' : 'Accepted'}</span>
              </summary>
              {item.section && document !== undefined
                ? <SectionDiff document={document} change={item.section} />
                : <div className="review-markdown"><MarkdownMessage text={item.markdown} /></div>}
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Fallback for a proposal the server can no longer resume (restart, retention, deleted thread, or hydrated without a
 * pending approval). Keeps what the user had decided visible and read-only, and offers two ways on: re-propose with
 * those edits, or start over. It takes focus like the other review cards (the chat announcer stays silent for it).
 */
export function ExpiredProposal({ interrupts = [], document, disabled = false, onRepropose, onRetry, autoFocus = true }: ExpiredProposalProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => { if (autoFocus) headingRef.current?.focus(); }, [autoFocus]);

  const summaries = interrupts.flatMap((interrupt) => { const summary = summarizeExpired(interrupt); return summary ? [summary] : []; });
  const kept = hasKeptContent(summaries);
  const truncated = kept && Boolean(buildRepromposeMessage(interrupts)?.truncated);

  return (
    <div className="proposal-panel review-card review-expired" role="region" aria-labelledby={headingId}>
      <span className="eyebrow">Proposal expired</span>
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>{proposalExpiredTitle}</h3>
      <p className="proposal-rationale">{proposalExpiredReason}</p>
      {kept && summaries.map((summary) => <Summary key={summary.interruptId} summary={summary} document={document} headingId={`${headingId}-${summary.interruptId}`} />)}
      {truncated && <p className="review-rationale">Your edits are long: only the first part is sent to the agent.</p>}
      <div className="review-bulk">
        <button type="button" className="button button-primary button-small" disabled={disabled || !onRepropose} onClick={onRepropose}>
          {kept ? 'Ask the agent to re-propose with my edits' : 'Ask the agent to re-propose'}
        </button>
        <button type="button" className="button button-secondary button-small" disabled={disabled || !onRetry} onClick={onRetry}>Start over</button>
      </div>
    </div>
  );
}
