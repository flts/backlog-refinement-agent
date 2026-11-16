import type { DocumentPreview } from '../contracts';
import { sectionDiff, type ProposalForPreview } from './proposal';
import { SectionDiff } from './SectionDiff';

const modeLabel = { replace: 'Replace', append: 'Append' } as const;

export interface PredictivePreviewProps extends Pick<ProposalForPreview, 'status'> {
  /** The current document of the item; the proposal is applied to it in a sandbox, never saved. */
  document: string;
  proposal: DocumentPreview;
}

/**
 * Track changes in the Document tab (mockup 02): the proposed sections as per-section diffs against the current
 * document. Changes are conveyed by text ("New section", "Added:", "Removed:"), not only by colour.
 */
export function PredictivePreview({ document, proposal, status }: PredictivePreviewProps) {
  const streaming = status === 'streaming';
  return (
    <section className="predictive-preview" aria-label="Proposed changes" aria-busy={streaming || undefined}>
      <p className="predictive-banner">
        <span aria-hidden="true">✳</span>
        <span><strong>Proposed changes — review in the chat</strong>{streaming && <span className="predictive-live"> · the agent is still writing…</span>}</span>
      </p>
      {proposal.summary && <p className="predictive-summary">{proposal.summary}</p>}
      {proposal.suggestedTitle && <p className="predictive-meta">Suggested title: <strong>{proposal.suggestedTitle}</strong></p>}
      {proposal.suggestedStatus && <p className="predictive-meta">Suggested status: <strong>{proposal.suggestedStatus === 'ready' ? 'Ready' : 'Ready · questions'}</strong></p>}
      <ol className="predictive-sections">
        {proposal.sections.map((section) => {
          const { isNew } = sectionDiff(document, section);
          return (
            <li key={section.id} className="predictive-section">
              <h4>{section.heading} <span className="review-pill">{isNew ? 'New section' : modeLabel[section.mode]}</span></h4>
              <SectionDiff document={document} change={section} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
