import React from 'react';
import type { Item, ItemStatus, ItemSummary, ItemType, Revision } from '../api';
import { PresenceAvatars, RemoteChangeNotice, type PresenceUser, type RemoteItemChange } from '../collab';
import { HistoryPanel } from '../history';
import type { StateQuality } from '../contracts';
import { QualityPanel } from '../quality';
import { parseChecklistSections } from '../domain/document';
import { canTransitionItemStatus } from '../domain/services';
import { ItemMenu, type MenuAction } from './ItemMenu';
import { PanelTabs, tabButtonId, tabPanelId, type PanelTab } from './PanelTabs';
import { itemTypeLabel, statusText, typeShort } from './labels';
import { PredictivePreview, type ProposalForPreview } from '../review';

function childTypeOptions(type: ItemType): ItemType[] {
  if (type === 'capability') return ['feature', 'enabler'];
  if (type === 'feature') return ['user-story', 'enabler'];
  return [];
}

/** Tab ids of the document panel; further tabs are added to `tabs` in PreviewPanel. */
export type PreviewTabId = 'document' | 'open-items' | 'quality' | 'history';
const tabsPrefix = 'preview';

export type PreviewPanelProps = {
  className: string;
  item?: Item;
  parentItem?: ItemSummary;
  /** Needed for the History tab (compare loads single revisions). */
  projectId?: string;
  /** Saved versions, newest first; the first one is the current content. */
  revisions?: Revision[];
  revisionsLoading?: boolean;
  /** Resolves an actor email to a display name. */
  nameOf?: (email: string) => string;
  /** Other people who have this item open. */
  presence?: PresenceUser[];
  /** The latest change of this item by somebody else (announced politely). */
  remoteChange?: RemoteItemChange & { key: number };
  /** Only its presence matters: the agent thread (or a placeholder before the first message) the actions go to. */
  session?: { id: string };
  busy: boolean;
  menuActions: MenuAction[];
  onSelectItem: (id: string) => void;
  onUpdate: (changes: { title?: string; document?: string }) => void;
  onResolveChecklist: (line: number, action: 'check' | 'remove', message: string) => void;
  /** Restores a saved version as a new version; resolves to whether it worked. The History tab is only offered when this is set. */
  onRestore?: (revisionId: string) => Promise<boolean>;
  onChangeStatus: (status: ItemStatus) => void;
  onAssessQuality: () => void;
  /** Latest assessment of the agent state (`run.agentState.quality`); shown when newer than the stored one. */
  liveQuality?: StateQuality | null;
  onProposeChildren: (type: ItemType) => void;
  /** Track changes of the proposal that is streaming or waiting for review (`proposalForPreview(run)`). */
  proposal?: ProposalForPreview | null;
};

export function PreviewPanel({ className, item, parentItem, projectId, revisions = [], revisionsLoading = false, nameOf = (email) => email, presence = [], remoteChange, session, busy, menuActions, onSelectItem, onUpdate, onResolveChecklist, onRestore, onChangeStatus, onAssessQuality, liveQuality, onProposeChildren, proposal }: PreviewPanelProps) {
  const checklist = React.useMemo(() => item ? parseChecklistSections(item.document) : [], [item?.document]);
  const [tabByItem, setTabByItem] = React.useState<Record<string, PreviewTabId>>({});
  const openAssumptions = checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked);
  const openQuestions = checklist.filter((entry) => entry.kind === 'question' && !entry.checked);
  const tabs: PanelTab<PreviewTabId>[] = [
    { id: 'document', label: 'Document' },
    { id: 'open-items', label: 'Open items', count: openAssumptions.length + openQuestions.length },
    { id: 'quality', label: 'Quality' },
    ...(projectId && onRestore ? [{ id: 'history' as const, label: 'History' }] : []),
  ];
  const requestedTab = item ? tabByItem[item.id] : undefined;
  const activeTab: PreviewTabId = tabs.some((tab) => tab.id === requestedTab) ? requestedTab! : 'document';
  return (
    <aside className={className}>
      {item ? <>
            <div className="preview-head">
              <div className="preview-type"><span className="type-icon">{typeShort[item.type]}</span>
              {/* <span>{itemTypeLabel[item.type]}</span> */}
              {parentItem && <div className="context-banner"><span className="context-icon" aria-hidden="true">↳</span><span>Refining within <strong>{parentItem.title}</strong></span><button onClick={() => void onSelectItem(parentItem.id)}>View parent</button></div>}
              {/* {parentItem && <p className="preview-crumb"><button className="text-link" onClick={() => void onSelectItem(parentItem.id)}>{parentItem.title}</button><span className="crumb-sep">/</span></p>} */}
              <span className={`status-chip status-${item.status}`}>{statusText(item.status)}</span><ItemMenu actions={menuActions} /></div>
              <PresenceAvatars people={presence} label="People viewing this item" showLabel /><RemoteChangeNotice change={remoteChange} />
              <label className="field-label" htmlFor="item-title">Title</label><input id="item-title" className="preview-title-input" value={item.title} onChange={(event) => onUpdate({ title: event.target.value })} />
            </div>
            <PanelTabs tabs={tabs} active={activeTab} idPrefix={tabsPrefix} label="Item views" onChange={(id) => setTabByItem((current) => ({ ...current, [item.id]: id }))} />
            <div className="preview-scroll" role="tabpanel" id={tabPanelId(tabsPrefix, activeTab)} aria-labelledby={tabButtonId(tabsPrefix, activeTab)}>
              {activeTab === 'document' && <>
              {proposal && <PredictivePreview document={item.document} proposal={proposal.proposal} status={proposal.status} />}
              <label className="field-label" htmlFor="item-description">Document (Markdown)</label><textarea id="item-description" className="preview-description" value={item.document} placeholder="What is this item about? Add a starting point or refine it with the agent." onChange={(event) => onUpdate({ document: event.target.value })} rows={14} />
              </>}
              {activeTab === 'open-items' && <>
              {openAssumptions.length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>Assumptions to confirm</h3><span className="count-badge amber">{openAssumptions.length}</span></div>{openAssumptions.map((entry) => <div className="uncertainty-card assumption-card" key={entry.line}><span aria-hidden="true">◇</span><p>{entry.text}</p><button className="uncertainty-action" aria-label="Confirm assumption" title="Confirm" onClick={() => onResolveChecklist(entry.line, 'check', 'Assumption confirmed.')}><span aria-hidden="true">✓</span></button><button className="uncertainty-action reject" aria-label="Reject assumption" title="Reject" onClick={() => onResolveChecklist(entry.line, 'remove', 'Assumption rejected.')}><span aria-hidden="true">×</span></button></div>)}</section>}
              {openQuestions.length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>Open questions</h3><span className="count-badge blue">{openQuestions.length}</span></div>{openQuestions.map((entry) => <div className="uncertainty-card question-card" key={entry.line}><span aria-hidden="true">?</span><p>{entry.text}</p><button className="uncertainty-action" aria-label="Mark question resolved" title="Resolve" onClick={() => onResolveChecklist(entry.line, 'check', 'Question marked resolved.')}><span aria-hidden="true">✓</span></button></div>)}</section>}
              {openAssumptions.length + openQuestions.length === 0 && <p className="history-note">No open assumptions or questions. Unchecked checklist items under “Assumptions” and “Open questions” in the document show up here.</p>}
              </>}
              {activeTab === 'quality' && <QualityPanel item={item} live={liveQuality} busy={busy} onAssess={onAssessQuality} />}
              {activeTab === 'history' && projectId && onRestore && <HistoryPanel key={item.id} projectId={projectId} item={item} revisions={revisions} loading={revisionsLoading} nameOf={nameOf} busy={busy} onRestore={onRestore} />}
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
                {activeTab !== 'quality' && <button className="button button-secondary button-small" disabled={busy} onClick={() => onAssessQuality()}>Assess quality</button>}
              </section>
                <div className="decompose-area">
              {childTypeOptions(item.type).length > 0 && <>
                  <div className="decompose-title">
                    <span aria-hidden="true">✳</span>
                    <div><strong>Break this down</strong><small>Propose child items for your review</small></div>
                  </div>
                  <div className="decompose-buttons">
                    {childTypeOptions(item.type).map((type) => <button key={type} className="button button-secondary button-small" disabled={busy || !session} onClick={() => onProposeChildren(type)}><span aria-hidden="true">＋</span> {type === 'feature' ? 'Features' : type === 'user-story' ? 'User stories' : 'Enablers'}</button>)}
                  </div>
              </>}
                </div>
            </div>
      </> : <div className="preview-empty"><span className="type-icon">↗</span><h3>Your item preview</h3><p>Choose an item to see its structure and refinement details.</p></div>}
    </aside>
  );
}
