import React from 'react';
import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';
import type { BacklogRelationship } from '../domain/relationship';
import type { RefinementSession } from '../domain/refinement-session';
import { diffDocuments, parseChecklistSections } from '../domain/document';
import { canTransitionItemStatus } from '../domain/services';
import { ItemMenu, type MenuAction } from './ItemMenu';
import { itemTypeLabel, statusText, typeShort } from './labels';

export function qualityDiagnostics(quality: NonNullable<BacklogItem['quality']>): string[] {
  return [
    quality.excessiveTechnicalDetail && 'Contains excessive technical detail',
    quality.speculativeScope && 'Contains speculative scope',
    quality.unnecessaryConfigurability && 'Contains unnecessary configurability',
    quality.mixedOutcomes && 'Mixes multiple outcomes',
    quality.suggestedItemType && `Better suited as: ${itemTypeLabel[quality.suggestedItemType]}`,
    ...(quality.suggestedSplit ?? []).map((part) => `Suggested split: ${part}`),
    ...(quality.excludedFollowUpCandidates ?? []).map((part) => `Follow-up candidate: ${part}`),
  ].filter((entry): entry is string => Boolean(entry));
}

function childTypeOptions(type: BacklogItemType): BacklogItemType[] {
  if (type === 'capability') return ['feature', 'enabler'];
  if (type === 'feature') return ['user-story', 'enabler'];
  return [];
}

export type PreviewPanelProps = {
  className: string;
  item?: BacklogItem;
  items: BacklogItem[];
  relationships: BacklogRelationship[];
  parentItem?: BacklogItem;
  session?: RefinementSession;
  busy: boolean;
  menuActions: MenuAction[];
  onSelectItem: (id: string) => void;
  onCopy: () => void;
  onUpdate: (changes: Partial<BacklogItem>) => void;
  onResolveChecklist: (line: number, action: 'check' | 'remove', message: string) => void;
  onUndo: () => void;
  onChangeStatus: (status: BacklogItem['status']) => void;
  onAssessQuality: () => void;
  onProposeChildren: (type: BacklogItemType) => void;
};

export function PreviewPanel({ className, item, items, relationships, parentItem, session, busy, menuActions, onSelectItem, onCopy, onUpdate, onResolveChecklist, onUndo, onChangeStatus, onAssessQuality, onProposeChildren }: PreviewPanelProps) {
  const checklist = React.useMemo(() => item ? parseChecklistSections(item.description) : [], [item]);
  const lastRevision = item?.revisions[item.revisions.length - 1];
  const lastChange = item && lastRevision ? diffDocuments(lastRevision.description, item.description) : undefined;
  return (
    <aside className={className}>
      {item ? <>
            <div className="preview-head">
              <div className="preview-type"><span className="type-icon">{typeShort[item.type]}</span>
              {/* <span>{itemTypeLabel[item.type]}</span> */}
              {parentItem && <div className="context-banner"><span className="context-icon">↳</span><span>Refining within <strong>{parentItem.title}</strong></span><button onClick={() => void onSelectItem(parentItem.id)}>View parent</button></div>}
              {/* {parentItem && <p className="preview-crumb"><button className="text-link" onClick={() => void onSelectItem(parentItem.id)}>{parentItem.title}</button><span className="crumb-sep">/</span></p>} */}
              <span className={`status-chip status-${item.status}`}>{statusText(item.status)}</span><ItemMenu actions={menuActions} /></div>
              <label className="field-label" htmlFor="item-title">TITLE</label><input id="item-title" className="preview-title-input" value={item.title} onChange={(event) => onUpdate({ title: event.target.value })} />
            </div>
            <div className="preview-scroll">
              <label className="field-label" htmlFor="item-description">DOCUMENT (MARKDOWN)</label><textarea id="item-description" className="preview-description" value={item.description} placeholder="What is this item about? Add a starting point or refine it with the agent." onChange={(event) => onUpdate({ description: event.target.value })} rows={14} />
              {checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked).length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>Assumptions to confirm</h3><span className="count-badge amber">{checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked).length}</span></div>{checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked).map((entry) => <div className="uncertainty-card assumption-card" key={entry.line}><span>◇</span><p>{entry.text}</p><button className="uncertainty-action" aria-label="Confirm assumption" title="Confirm" onClick={() => onResolveChecklist(entry.line, 'check', 'Assumption confirmed.')}>✓</button><button className="uncertainty-action reject" aria-label="Reject assumption" title="Reject" onClick={() => onResolveChecklist(entry.line, 'remove', 'Assumption rejected.')}>×</button></div>)}</section>}
              {checklist.filter((entry) => entry.kind === 'question' && !entry.checked).length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>Open questions</h3><span className="count-badge blue">{checklist.filter((entry) => entry.kind === 'question' && !entry.checked).length}</span></div>{checklist.filter((entry) => entry.kind === 'question' && !entry.checked).map((entry) => <div className="uncertainty-card question-card" key={entry.line}><span>?</span><p>{entry.text}</p><button className="uncertainty-action" aria-label="Mark question resolved" title="Resolve" onClick={() => onResolveChecklist(entry.line, 'check', 'Question marked resolved.')}>✓</button></div>)}</section>}
              {item.revisions.length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>AI changes</h3><span className="subtle-label">{item.revisions.length} saved</span></div>{lastChange && <ul className="quality-list">{lastChange.removed.slice(0, 5).map((line) => <li key={`r-${line}`} className="quality-missing"><span>− {line}</span></li>)}{lastChange.added.slice(0, 5).map((line) => <li key={`a-${line}`} className="quality-clear"><span>+ {line}</span></li>)}</ul>}<button className="button button-secondary button-small" onClick={() => onUndo()}>Undo last AI change</button></section>}
              {/* <section className="preview-section"><div className="preview-section-head"><h3>Structure</h3><span className="subtle-label">{relationships.filter((relationship) => relationship.sourceId === item.id || relationship.targetId === item.id).length} links</span></div>{parentItem ? <button className="related-item" onClick={() => void onSelectItem(parentItem.id)}><span className="type-icon tiny">{typeShort[parentItem.type]}</span>{parentItem.title}<span>↗</span></button> : <p className="muted-copy">No parent item linked.</p>}{items.filter((item) => relationships.some((relationship) => relationship.type === 'parent-child' && relationship.sourceId === item.id && relationship.targetId === item.id)).map((item) => <button className="related-item" key={item.id} onClick={() => void onSelectItem(item.id)}><span className="type-icon tiny">{typeShort[item.type]}</span>{item.title}<span>↗</span></button>)}</section> */}
              {item.quality && <section className="preview-section quality-section" aria-label="Quality assessment"><div className="preview-section-head"><h3>Quality assessment</h3><span className="status-indicator"><i /> {item.quality.overall === 'ready' ? 'Ready' : item.quality.overall === 'ready-with-open-questions' ? 'Ready with open questions' : 'Needs clarification'}</span></div><ul className="quality-list">{item.quality.areas.map((entry) => <li key={entry.area} className={`quality-${entry.level}`}><strong>{entry.area.replaceAll('-', ' ')}</strong><span className="quality-level">{entry.level.replaceAll('-', ' ')}</span>{entry.note && <small>{entry.note}</small>}</li>)}</ul>{qualityDiagnostics(item.quality).length > 0 && <ul className="quality-list quality-diagnostics">{qualityDiagnostics(item.quality).map((text) => <li key={text} className="quality-unclear"><span>{text}</span></li>)}</ul>}</section>}
            </div>
            <div className="bottom-area">
              <section className="preview-section quality-section status-section">
                <div className="preview-section-head">
                  <h3>Refinement status</h3><span className="status-indicator"><i /> {statusText(item.status)}</span>
                </div>
                <p>{item.status === 'ready-with-open-questions' ? 'Ready to move forward with a few details to resolve.' : item.status === 'ready' || item.status === 'complete' ? 'This item has enough clarity to move forward.' : 'Keep refining to clarify the outcome, value, and boundaries.'}</p>
                {(canTransitionItemStatus(item.status, 'ready') || (item.status === 'draft' && canTransitionItemStatus('draft', 'refining') && canTransitionItemStatus('refining', 'ready'))) && <button className="button button-secondary button-small" disabled={busy || (item.status === 'draft' && !session)} onClick={() => onChangeStatus('ready')}>Mark ready</button>}
                {item.status === 'ready' && canTransitionItemStatus(item.status, 'complete') && <button className="button button-secondary button-small" disabled={busy} onClick={() => onChangeStatus('complete')}>Mark complete</button>}
                {item.status !== 'draft' && canTransitionItemStatus(item.status, 'refining') && <button className="button button-secondary button-small" disabled={busy} onClick={() => onChangeStatus('refining')}>{item.status === 'complete' ? 'Reopen item' : 'Return to refining'}</button>}
                <button className="button button-secondary button-small" disabled={busy} onClick={() => onAssessQuality()}>Assess quality</button>
              </section>
                <div className="decompose-area">
              {childTypeOptions(item.type).length > 0 && <>
                  <div className="decompose-title">
                    <span>✳</span>
                    <div><strong>Break this down</strong><small>Propose child items for your review</small></div>
                  </div>
                  <div className="decompose-buttons">
                    {childTypeOptions(item.type).map((type) => <button key={type} className="button button-secondary button-small" disabled={busy || !session} onClick={() => onProposeChildren(type)}>＋ {type === 'feature' ? 'Features' : type === 'user-story' ? 'User stories' : 'Enablers'}</button>)}
                  </div>
              </>}
                </div>
            </div>
      </> : <div className="preview-empty"><span className="type-icon">↗</span><h3>Your item preview</h3><p>Choose an item to see its structure and refinement details.</p></div>}
    </aside>
  );
}
