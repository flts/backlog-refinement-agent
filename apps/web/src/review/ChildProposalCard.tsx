import { useEffect, useId, useRef, useState } from 'react';
import { editedArgsFor } from '../agent';
import type { ResumeDecision } from '../agent';
import { ProposeChildItemsArgsSchema, type ProposedChild, type ProposeChildItemsArgs } from '../contracts';
import { MarkdownMessage } from '../chat/MarkdownMessage';
import { itemTypeLabel } from '../app/labels';
import { ExpiredProposal } from './ExpiredProposal';
import { OverlapWarning } from './ReviewCard';
import type { ReviewInterrupt } from '../run';
import { readChildProposal, type SimilarItem } from './proposal';
import { useReviewState, type Decision } from './useReviewState';

export interface ChildProposalCardProps {
  interrupt: ReviewInterrupt;
  /** The id of the item the children are proposed for (a relationship endpoint may refer to it). */
  parentItemId?: string;
  disabled?: boolean;
  locked?: boolean;
  similar?: readonly SimilarItem[];
  onSelectItem?: (id: string) => void;
  onDecide: (decision: ResumeDecision) => void;
  onRetry?: () => void;
  onRepropose?: () => void;
  autoFocus?: boolean;
}

const statusLabel: Record<Decision, string> = { pending: 'Undecided', accepted: 'Accepted', rejected: 'Rejected' };

interface ChildEdit { title: string; markdown: string }

/** Full-replacement `editedArgs` for `propose_child_items`: accepted children (with edits) and only relationships between kept endpoints. */
export function buildEditedChildArgs(interrupt: Pick<ReviewInterrupt, 'args'>, proposal: ProposeChildItemsArgs, children: ProposedChild[]): Record<string, unknown> | null {
  const kept = new Set(children.map((child) => child.proposalId));
  const replacements: Record<string, unknown> = { children };
  if (proposal.relationships) {
    const known = new Set(proposal.children.map((child) => child.proposalId));
    replacements.relationships = proposal.relationships.filter((rel) => [rel.sourceRef, rel.targetRef].every((ref) => !known.has(ref) || kept.has(ref)));
  }
  const edited = editedArgsFor(interrupt, replacements);
  return ProposeChildItemsArgsSchema.safeParse(edited).success ? edited : null;
}

export function ChildProposalCard({ interrupt, parentItemId, disabled = false, locked = false, similar = [], onSelectItem, onDecide, onRetry, onRepropose, autoFocus = true }: ChildProposalCardProps) {
  const proposal = readChildProposal(interrupt.args);
  if (interrupt.expired) return <ExpiredProposal interrupts={[interrupt]} onRetry={onRetry} onRepropose={onRepropose} disabled={disabled} autoFocus={autoFocus} />;
  if (!proposal) {
    return (
      <div className="proposal-panel review-card" role="region" aria-label="Proposal cannot be shown">
        <p className="proposal-rationale">The proposal is incomplete and cannot be reviewed. Reject it to let the agent try again.</p>
        <div className="proposal-actions"><span /><button type="button" className="button button-secondary button-small" disabled={disabled || locked} onClick={() => onDecide({ interruptId: interrupt.id, approved: false })}>Reject</button></div>
      </div>
    );
  }
  return <ChildForm interrupt={interrupt} proposal={proposal} parentItemId={parentItemId} disabled={disabled} locked={locked} similar={similar} onSelectItem={onSelectItem} onDecide={onDecide} autoFocus={autoFocus} />;
}

function ChildForm({ interrupt, proposal, parentItemId, disabled, locked, similar, onSelectItem, onDecide, autoFocus }: Required<Pick<ChildProposalCardProps, 'disabled' | 'locked' | 'autoFocus' | 'similar'>> & Pick<ChildProposalCardProps, 'interrupt' | 'parentItemId' | 'onSelectItem' | 'onDecide'> & { proposal: ProposeChildItemsArgs }) {
  const ids = proposal.children.map((child) => child.proposalId);
  const review = useReviewState<ChildEdit>(ids);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChildEdit>({ title: '', markdown: '' });
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);
  const headingId = useId();

  useEffect(() => { if (autoFocus) headingRef.current?.focus(); }, [autoFocus]);
  useEffect(() => { if (editing) titleRef.current?.focus(); }, [editing]);
  useEffect(() => {
    if (!editing && returnFocusTo.current) {
      editButtons.current.get(returnFocusTo.current)?.focus();
      returnFocusTo.current = null;
    }
  }, [editing]);

  const childOf = (id: string): ProposedChild => {
    const base = proposal.children.find((child) => child.proposalId === id)!;
    const edit = review.edits[id];
    return edit ? { ...base, title: edit.title, markdown: edit.markdown } : base;
  };
  const labelOf = (ref: string) => (ref === parentItemId ? 'this item' : proposal.children.find((child) => child.proposalId === ref)?.title ?? ref);
  const say = (text: string) => setAnnouncement(text);

  function decide(child: ProposedChild, decision: Decision) {
    review.set(child.proposalId, decision, decision === 'accepted' ? review.edits[child.proposalId] : undefined);
    say(`“${child.title}” ${statusLabel[decision].toLowerCase()}.`);
  }

  function closeEdit(id: string) { returnFocusTo.current = id; setEditing(null); }

  function submit(decisions: Record<string, Decision>) {
    const accepted = proposal.children.filter((child) => decisions[child.proposalId] === 'accepted').map((child) => childOf(child.proposalId));
    if (accepted.length === 0) { onDecide({ interruptId: interrupt.id, approved: false }); return; }
    const editedArgs = buildEditedChildArgs(interrupt, proposal, accepted);
    if (!editedArgs) { setProblem('Your edits are not valid (every child needs a title). Check them and try again.'); return; }
    setProblem(null);
    onDecide({ interruptId: interrupt.id, approved: true, editedArgs });
  }

  const busy = disabled || locked;
  const rejectedIds = new Set(ids.filter((id) => review.decisionOf(id) === 'rejected'));
  const rejected = rejectedIds.size;
  const relationships = proposal.relationships ?? [];

  return (
    <div className="proposal-panel review-card" role="region" aria-labelledby={headingId}>
      <div className="proposal-heading">
        <div>
          <span className="eyebrow">Agent proposes {itemTypeLabel[proposal.childType].toLowerCase()} items</span>
          <h3 id={headingId} ref={headingRef} tabIndex={-1}>{proposal.rationale}</h3>
        </div>
      </div>
      <OverlapWarning similar={similar} onSelectItem={onSelectItem} />
      <ul className="review-sections">
        {proposal.children.map((original) => {
          const child = childOf(original.proposalId);
          const decision = review.decisionOf(original.proposalId);
          const isEditing = editing === original.proposalId;
          return (
            <li key={original.proposalId} className={`review-section review-${decision}`}>
              <div className="review-section-head">
                <h4>{child.title}</h4>
                <span className="review-pill">{itemTypeLabel[proposal.childType]}</span>
                <span className="review-pill review-state">{review.edits[original.proposalId] && decision === 'accepted' ? 'Edited' : statusLabel[decision]}</span>
              </div>
              {isEditing ? (
                <div className="review-editor">
                  <label htmlFor={`${headingId}-${original.proposalId}-t`}>Title</label>
                  <input id={`${headingId}-${original.proposalId}-t`} ref={titleRef} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeEdit(original.proposalId); } }} />
                  <label htmlFor={`${headingId}-${original.proposalId}-m`}>Markdown</label>
                  <textarea id={`${headingId}-${original.proposalId}-m`} rows={8} value={draft.markdown} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeEdit(original.proposalId); } }} />
                  <div className="review-row-actions">
                    <button type="button" className="button button-primary button-small" disabled={!draft.title.trim()} onClick={() => { review.set(original.proposalId, 'accepted', { title: draft.title.trim(), markdown: draft.markdown }); say(`“${draft.title.trim()}” edited and accepted.`); closeEdit(original.proposalId); }}>Save and accept</button>
                    <button type="button" className="button button-secondary button-small" onClick={() => closeEdit(original.proposalId)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="review-markdown"><MarkdownMessage text={child.markdown} /></div>
                  <div className="review-row-actions" role="group" aria-label={`Decide on ${child.title}`}>
                    <button type="button" className="button button-secondary button-small" aria-pressed={decision === 'accepted'} disabled={busy} onClick={() => decide(original, 'accepted')} aria-label={`Accept ${child.title}`}>Accept</button>
                    <button type="button" className="button button-secondary button-small" disabled={busy} ref={(node) => { if (node) editButtons.current.set(original.proposalId, node); else editButtons.current.delete(original.proposalId); }}
                      onClick={() => { setDraft({ title: child.title, markdown: child.markdown }); setEditing(original.proposalId); }} aria-label={`Edit ${child.title}`}>Edit</button>
                    <button type="button" className="button button-secondary button-small" aria-pressed={decision === 'rejected'} disabled={busy} onClick={() => decide(original, 'rejected')} aria-label={`Reject ${child.title}`}>Reject</button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {relationships.length > 0 && (
        <section className="review-relationships" aria-label="Relationships">
          <h4>Relationships</h4>
          <ul>
            {relationships.map((rel, index) => {
              const dropped = [rel.sourceRef, rel.targetRef].some((ref) => rejectedIds.has(ref));
              return (
                <li key={index} className={dropped ? 'review-dropped' : undefined}>
                  {labelOf(rel.sourceRef)} <span className="review-rel-type">{rel.type}</span> {labelOf(rel.targetRef)}
                  {dropped && <em> — will not be created because one side is rejected</em>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {problem && <p className="review-problem" role="alert">{problem}</p>}
      <p className="review-tally">{review.accepted} accepted · {rejected} rejected · {review.pending} undecided{review.pending > 0 ? ' (left out unless accepted)' : ''}</p>
      <div className="review-bulk">
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { review.acceptAll(); say('All items accepted.'); }}>Accept all</button>
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { review.rejectAll(); say('All items rejected.'); }}>Reject all</button>
        {review.pending > 0 && review.accepted + rejected > 0 && (
          <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => submit(review.acceptRemaining())}>Accept remaining &amp; continue</button>
        )}
        <button type="button" className="button button-primary button-small review-submit" disabled={busy || editing !== null} onClick={() => submit(review.resolved())}>
          {review.accepted === 0 ? 'Reject proposal' : `Create ${review.accepted} ${review.accepted === 1 ? 'item' : 'items'}`}
        </button>
      </div>
      <p className="sr-only" role="status">{announcement}</p>
    </div>
  );
}
