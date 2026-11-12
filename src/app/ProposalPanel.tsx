import React from 'react';
import type { DecompositionProposal } from '../domain/proposal';
import { parseChecklistSections, splitSections } from '../domain/document';
import { typeShort } from './labels';

type Props = {
  proposal: DecompositionProposal;
  selected: string[];
  busy: boolean;
  onChange: (proposal: DecompositionProposal) => void;
  onSelectedChange: (selected: string[]) => void;
  onAccept: () => void;
  onDismiss: () => void;
};

function filledSummary(description: string): string {
  const sections = splitSections(description).sections;
  if (!sections.length) return '';
  const filled = sections.filter((section) => section.body.trim() && !/^(- \[ \]\s*)?$/.test(section.body.trim())).length;
  return ` · ${filled}/${sections.length} sections filled`;
}

export function ProposalPanel({ proposal, selected, busy, onChange, onSelectedChange, onAccept, onDismiss }: Props) {
  const update = (id: string, changes: Partial<DecompositionProposal['children'][number]>) =>
    onChange({ ...proposal, children: proposal.children.map((child) => child.proposalId === id ? { ...child, ...changes } : child) });
  return (
    <div className="proposal-panel">
      <div className="proposal-heading"><div><span className="eyebrow">Decomposition proposal</span><h3>Possible next pieces</h3></div><button className="close-button" onClick={onDismiss} aria-label="Dismiss proposal"><span aria-hidden="true">×</span></button></div>
      <p className="proposal-rationale">{proposal.rationale}</p>
      <div className="proposal-list">{proposal.children.map((child) => {
        const entries = parseChecklistSections(child.description);
        return (
          <label className="proposal-item" key={child.proposalId}>
            <input type="checkbox" checked={selected.includes(child.proposalId)} onChange={(event) => onSelectedChange(event.target.checked ? [...selected, child.proposalId] : selected.filter((id) => id !== child.proposalId))} />
            <span className="proposal-copy">
              <input aria-label="Proposal title" value={child.title} onChange={(event) => update(child.proposalId, { title: event.target.value })} />
              <small className="muted-copy">{entries.filter((entry) => entry.kind === 'assumption').length} assumptions · {entries.filter((entry) => entry.kind === 'question').length} open questions{filledSummary(child.description)}</small>
              <textarea aria-label="Proposal description" rows={10} value={child.description} placeholder="Add a short description before accepting" onChange={(event) => update(child.proposalId, { description: event.target.value })} />
            </span>
            <span className="type-pill">{typeShort[child.type]}</span>
          </label>
        );
      })}</div>
      <div className="proposal-actions"><span>{selected.length} selected</span><button className="button button-primary button-small" disabled={!selected.length || busy} onClick={onAccept}>Add selected items <span aria-hidden="true">→</span></button></div>
    </div>
  );
}
