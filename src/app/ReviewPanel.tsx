import React from 'react';
import type { AssessmentProposal } from '../domain/proposal';
import { applySectionUpdates, diffDocuments } from '../domain/document';

type Props = {
  currentDescription: string;
  proposal: AssessmentProposal;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
};

export function ReviewPanel({ currentDescription, proposal, busy, onApply, onDiscard }: Props) {
  const { document } = applySectionUpdates(currentDescription, proposal.sectionUpdates);
  const diff = diffDocuments(currentDescription, document);
  const empty = !diff.added.length && !diff.removed.length;
  return (
    <div className="proposal-panel" role="region" aria-label="Review AI changes">
      <div className="proposal-heading"><div><span className="eyebrow">REVIEW AI CHANGES</span><h3>Proposed document changes</h3></div></div>
      <p className="proposal-rationale">{proposal.summary}</p>
      {empty ? <p className="muted-copy">The agent proposes no document changes.</p> : (
        <ul className="quality-list">
          {diff.removed.map((line) => <li key={`r-${line}`} className="quality-missing"><span>− {line}</span></li>)}
          {diff.added.map((line) => <li key={`a-${line}`} className="quality-clear"><span>+ {line}</span></li>)}
        </ul>
      )}
      <div className="proposal-actions">
        <button className="button button-secondary button-small" disabled={busy} onClick={onDiscard}>Discard</button>
        <button className="button button-primary button-small" disabled={busy} onClick={onApply}>Apply changes <span>→</span></button>
      </div>
    </div>
  );
}
