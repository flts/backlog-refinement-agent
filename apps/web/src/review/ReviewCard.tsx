import { useEffect, useId, useRef, useState } from 'react';
import type { ResumeDecision } from '../agent';
import { editedArgsFor } from '../agent';
import { ProposeDocumentChangesArgsSchema, type ProposeDocumentChangesArgs, type SectionChange } from '../contracts';
import type { ReviewInterrupt } from '../run';
import { readDocumentProposal, type SimilarItem } from './proposal';
import { SectionDiff } from './SectionDiff';
import { useReviewState, type Decision } from './useReviewState';

export interface ReviewCardProps {
  interrupt: ReviewInterrupt;
  /** The current document of the item (sections are diffed against it). */
  document: string;
  disabled?: boolean;
  /** Another proposal of the same run was already decided; this one is waiting for the rest. */
  locked?: boolean;
  similar?: readonly SimilarItem[];
  onSelectItem?: (id: string) => void;
  onDecide: (decision: ResumeDecision) => void;
  /** Expired proposals: ask the agent again (`run.retry()`). */
  onRetry?: () => void;
  /** Move focus into the card when it appears. */
  autoFocus?: boolean;
}

const statusLabel: Record<Decision, string> = { pending: 'Undecided', accepted: 'Accepted', rejected: 'Rejected' };
const modeLabel = { replace: 'Replace', append: 'Append' } as const;

export function ExpiredProposal({ onRetry, disabled }: { onRetry?: () => void; disabled?: boolean }) {
  return (
    <div className="proposal-panel review-card review-expired" role="region" aria-label="Expired proposal">
      <p className="review-expired-text"><strong>This proposal expired — ask again</strong></p>
      <p className="proposal-rationale">The agent service restarted before you decided, so the proposal can no longer be applied.</p>
      <div className="proposal-actions"><span /><button type="button" className="button button-primary button-small" disabled={disabled || !onRetry} onClick={onRetry}>Ask again</button></div>
    </div>
  );
}

export function OverlapWarning({ similar, onSelectItem }: { similar: readonly SimilarItem[]; onSelectItem?: (id: string) => void }) {
  if (similar.length === 0) return null;
  return (
    <p className="review-overlap" role="note">
      <span aria-hidden="true">⚠</span> Possible overlap with:{' '}
      {similar.map((item, index) => (
        <span key={item.id}>
          {index > 0 && ', '}
          <button type="button" className="text-link" onClick={() => onSelectItem?.(item.id)}>{item.title}</button> ({Math.round(item.score * 100)}% similar)
        </span>
      ))}
    </p>
  );
}

/** Builds and validates the full-replacement `editedArgs` (spike #3). Returns null when the result would not pass the contract. */
export function buildEditedDocumentArgs(
  interrupt: Pick<ReviewInterrupt, 'args'>,
  parts: { sections: SectionChange[]; title: string | null; status: string | null },
): Record<string, unknown> | null {
  const { suggestedTitle: _title, suggestedStatus: _status, ...kept } = interrupt.args;
  const replacements: Record<string, unknown> = { sections: parts.sections };
  if (parts.title) replacements.suggestedTitle = parts.title;
  if (parts.status) replacements.suggestedStatus = parts.status;
  const edited = editedArgsFor({ args: kept }, replacements);
  // The spike's tool names the version `base_version`; the contract `baseVersion`. Validate on contract keys, send the original ones.
  const { base_version, ...rest } = edited;
  const candidate = base_version !== undefined && rest.baseVersion === undefined ? { ...rest, baseVersion: base_version } : edited;
  return ProposeDocumentChangesArgsSchema.safeParse(candidate).success ? edited : null;
}

export function ReviewCard({ interrupt, document, disabled = false, locked = false, similar = [], onSelectItem, onDecide, onRetry, autoFocus = true }: ReviewCardProps) {
  const proposal = readDocumentProposal(interrupt.args);
  if (interrupt.expired) return <ExpiredProposal onRetry={onRetry} disabled={disabled} />;
  if (!proposal) {
    return (
      <div className="proposal-panel review-card" role="region" aria-label="Proposal cannot be shown">
        <p className="proposal-rationale">The proposal is incomplete and cannot be reviewed. Reject it to let the agent try again.</p>
        <div className="proposal-actions"><span /><button type="button" className="button button-secondary button-small" disabled={disabled || locked} onClick={() => onDecide({ interruptId: interrupt.id, approved: false })}>Reject</button></div>
      </div>
    );
  }
  return <ReviewForm interrupt={interrupt} proposal={proposal} document={document} disabled={disabled} locked={locked} similar={similar} onSelectItem={onSelectItem} onDecide={onDecide} autoFocus={autoFocus} />;
}

function ReviewForm({ interrupt, proposal, document, disabled, locked, similar = [], onSelectItem, onDecide, autoFocus }: Required<Pick<ReviewCardProps, 'disabled' | 'locked' | 'autoFocus'>> & Pick<ReviewCardProps, 'interrupt' | 'document' | 'similar' | 'onSelectItem' | 'onDecide'> & { proposal: ProposeDocumentChangesArgs }) {
  const ids = proposal.sections.map((section) => section.id);
  const review = useReviewState<string>(ids);
  const [title, setTitle] = useState(true);
  const [status, setStatus] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);
  const headingId = useId();

  useEffect(() => { if (autoFocus) headingRef.current?.focus(); }, [autoFocus]);
  useEffect(() => { if (editing) editorRef.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!editing && returnFocusTo.current) {
      editButtons.current.get(returnFocusTo.current)?.focus();
      returnFocusTo.current = null;
    }
  }, [editing]);

  const sectionOf = (id: string): SectionChange => {
    const base = proposal.sections.find((section) => section.id === id)!;
    const edit = review.edits[id];
    return edit === undefined ? base : { ...base, markdown: edit };
  };
  const isEdited = (id: string) => review.edits[id] !== undefined && review.edits[id] !== proposal.sections.find((section) => section.id === id)!.markdown;

  function say(text: string) { setAnnouncement(text); }

  function decide(section: SectionChange, decision: Decision) {
    review.set(section.id, decision, decision === 'accepted' ? review.edits[section.id] : undefined);
    say(`Section “${section.heading}” ${statusLabel[decision].toLowerCase()}.`);
  }

  function startEdit(section: SectionChange) {
    setDraft(sectionOf(section.id).markdown);
    setEditing(section.id);
  }

  function closeEdit(id: string) {
    returnFocusTo.current = id;
    setEditing(null);
  }

  function saveEdit(section: SectionChange) {
    review.set(section.id, 'accepted', draft);
    say(`Section “${section.heading}” edited and accepted.`);
    closeEdit(section.id);
  }

  function submit(decisions: Record<string, Decision>) {
    const accepted = proposal.sections.filter((section) => decisions[section.id] === 'accepted').map((section) => sectionOf(section.id));
    if (accepted.length === 0) {
      onDecide({ interruptId: interrupt.id, approved: false });
      return;
    }
    const editedArgs = buildEditedDocumentArgs(interrupt, {
      sections: accepted,
      title: title ? proposal.suggestedTitle ?? null : null,
      status: status ? proposal.suggestedStatus ?? null : null,
    });
    if (!editedArgs) {
      setProblem('Your edits are not valid (a section needs a non-empty heading and an id). Check them and try again.');
      return;
    }
    setProblem(null);
    onDecide({ interruptId: interrupt.id, approved: true, editedArgs });
  }

  const busy = disabled || locked;
  const accepted = review.accepted;
  const rejected = ids.filter((id) => review.decisionOf(id) === 'rejected').length;
  const acceptEverything = () => { review.acceptAll(); say('All sections accepted.'); };
  const rejectEverything = () => { review.rejectAll(); say('All sections rejected.'); };

  return (
    <div className="proposal-panel review-card" role="region" aria-labelledby={headingId}>
      <div className="proposal-heading">
        <div>
          <span className="eyebrow">Agent proposes changes</span>
          <h3 id={headingId} ref={headingRef} tabIndex={-1}>{proposal.summary}</h3>
        </div>
      </div>
      <OverlapWarning similar={similar} onSelectItem={onSelectItem} />
      {proposal.suggestedTitle && (
        <label className="review-toggle"><input type="checkbox" checked={title} disabled={busy} onChange={(event) => { setTitle(event.target.checked); say(`Suggested title ${event.target.checked ? 'accepted' : 'rejected'}.`); }} /> Rename the item to <strong>{proposal.suggestedTitle}</strong></label>
      )}
      {proposal.suggestedStatus && (
        <label className="review-toggle"><input type="checkbox" checked={status} disabled={busy} onChange={(event) => { setStatus(event.target.checked); say(`Suggested status ${event.target.checked ? 'accepted' : 'rejected'}.`); }} /> Set the status to <strong>{proposal.suggestedStatus === 'ready' ? 'Ready' : 'Ready · questions'}</strong></label>
      )}
      <ul className="review-sections">
        {proposal.sections.map((original) => {
          const section = sectionOf(original.id);
          const decision = review.decisionOf(original.id);
          const isEditing = editing === original.id;
          return (
            <li key={original.id} className={`review-section review-${decision}`}>
              <div className="review-section-head">
                <h4>{section.heading}</h4>
                <span className="review-pill">{modeLabel[section.mode]}</span>
                <span className="review-pill review-state">{isEdited(original.id) && decision === 'accepted' ? 'Edited' : statusLabel[decision]}</span>
              </div>
              {section.rationale && <p className="review-rationale">{section.rationale}</p>}
              {isEditing ? (
                <div className="review-editor">
                  <label htmlFor={`${headingId}-${original.id}`}>Edit “{section.heading}” (Markdown)</label>
                  <textarea id={`${headingId}-${original.id}`} ref={editorRef} rows={8} value={draft} onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeEdit(original.id); } }} />
                  <div className="review-row-actions">
                    <button type="button" className="button button-primary button-small" onClick={() => saveEdit(original)}>Save and accept</button>
                    <button type="button" className="button button-secondary button-small" onClick={() => closeEdit(original.id)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <SectionDiff document={document} change={section} />
                  <div className="review-row-actions" role="group" aria-label={`Decide on ${section.heading}`}>
                    <button type="button" className="button button-secondary button-small" aria-pressed={decision === 'accepted'} disabled={busy} onClick={() => decide(original, 'accepted')} aria-label={`Accept section ${section.heading}`}>Accept</button>
                    <button type="button" className="button button-secondary button-small" disabled={busy} ref={(node) => { if (node) editButtons.current.set(original.id, node); else editButtons.current.delete(original.id); }} onClick={() => startEdit(original)} aria-label={`Edit section ${section.heading}`}>Edit</button>
                    <button type="button" className="button button-secondary button-small" aria-pressed={decision === 'rejected'} disabled={busy} onClick={() => decide(original, 'rejected')} aria-label={`Reject section ${section.heading}`}>Reject</button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {problem && <p className="review-problem" role="alert">{problem}</p>}
      <p className="review-tally">{accepted} accepted · {rejected} rejected · {review.pending} undecided{review.pending > 0 ? ' (left out unless accepted)' : ''}</p>
      <div className="review-bulk">
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={acceptEverything}>Accept all</button>
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={rejectEverything}>Reject all</button>
        {review.pending > 0 && accepted + rejected > 0 && (
          <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { submit(review.acceptRemaining()); }}>Accept remaining &amp; continue</button>
        )}
        <button type="button" className="button button-primary button-small review-submit" disabled={busy || editing !== null} onClick={() => submit(review.resolved())}>
          {accepted === 0 ? 'Reject proposal' : `Apply ${accepted} ${accepted === 1 ? 'section' : 'sections'}`}
        </button>
      </div>
      <p className="sr-only" role="status">{announcement}</p>
    </div>
  );
}
