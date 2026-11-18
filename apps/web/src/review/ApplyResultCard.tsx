import { useState } from 'react';
import { MarkdownMessage } from '../chat/MarkdownMessage';
import { PROPOSE_DOCUMENT_CHANGES_TOOL_NAME, type ChildItemsResult, type DocumentChangesResult, type LastApply, type SectionConflict } from '../contracts';
import type { TranscriptEntry } from '../run';
import { DiffView } from '../settings/DiffView';
import { readPreviewArgs } from './proposal';

type Applied<T> = T & { toolCallId?: string; at?: string };

export const isChildResult = (result: LastApply): result is Applied<ChildItemsResult> => 'created' in result;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Applied 3 sections · 1 edited · 1 rejected · 1 conflicted" (applied counts edited sections too). */
export function documentResultSummary(result: DocumentChangesResult): string {
  const applied = new Set([...result.applied, ...result.edited]).size;
  const parts = [`Applied ${plural(applied, 'section')}`];
  if (result.edited.length) parts.push(`${result.edited.length} edited`);
  if (result.rejected.length) parts.push(`${result.rejected.length} rejected`);
  if (result.conflicted.length) parts.push(`${result.conflicted.length} conflicted`);
  return parts.join(' · ');
}

export function childResultSummary(result: ChildItemsResult): string {
  const parts = [`Created ${plural(result.created.length, 'item')}`];
  if (result.edited.length) parts.push(`${result.edited.length} edited`);
  if (result.rejected.length) parts.push(`${result.rejected.length} rejected`);
  if (result.failed.length) parts.push(`${result.failed.length} failed`);
  if (result.relationshipsCreated) parts.push(plural(result.relationshipsCreated, 'relationship'));
  return parts.join(' · ');
}

export interface ApplyResultCardProps {
  result: LastApply;
  /** The transcript: the original proposal args are found by the result's toolCallId (the transcript keeps the unedited arguments). */
  messages: readonly TranscriptEntry[];
  disabled?: boolean;
  /** Sends a chat message, e.g. to ask the agent to redo a conflicted section. */
  onSend?: (text: string) => void;
  /** Selects an item (created children) in the tree. */
  onSelectItem?: (id: string) => void;
}

function proposedMarkdown(messages: readonly TranscriptEntry[], toolCallId: string | undefined, sectionId: string): string | undefined {
  const tools = messages.filter((entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool' && entry.toolName === PROPOSE_DOCUMENT_CHANGES_TOOL_NAME);
  const entry = (toolCallId ? tools.find((tool) => tool.id === toolCallId) : undefined) ?? tools.at(-1);
  return readPreviewArgs(entry?.args)?.sections.find((section) => section.id === sectionId)?.markdown;
}

export function ConflictRow({ conflict, proposed, disabled, onRedo, onKeep }: { conflict: SectionConflict; proposed?: string; disabled: boolean; onRedo?: () => void; onKeep: () => void }) {
  return (
    <li className="review-conflict">
      <h4>{conflict.heading}</h4>
      <p className="review-rationale">{conflict.reason}</p>
      {conflict.currentMarkdown !== undefined && proposed !== undefined && (
        <details>
          <summary>Compare current version and proposal</summary>
          <DiffView before={conflict.currentMarkdown} after={proposed} beforeLabel="current version" afterLabel="proposed" />
        </details>
      )}
      {conflict.currentMarkdown !== undefined && proposed === undefined && (
        <details><summary>Current version</summary><div className="review-markdown"><MarkdownMessage text={conflict.currentMarkdown} /></div></details>
      )}
      <div className="review-row-actions">
        <button type="button" className="button button-secondary button-small" disabled={disabled || !onRedo} onClick={onRedo} aria-label={`Ask the agent to redo this section ${conflict.heading}`}>Ask the agent to redo this section</button>
        <button type="button" className="button button-secondary button-small" onClick={onKeep} aria-label={`Keep current ${conflict.heading}`}>Keep current</button>
      </div>
    </li>
  );
}

/** Compact outcome of an applied proposal (plan §6.5), with per-section conflict resolution or links to the created items. */
export function ApplyResultCard({ result, messages, disabled = false, onSend, onSelectItem }: ApplyResultCardProps) {
  const [kept, setKept] = useState<string[]>([]);
  if (isChildResult(result)) {
    return (
      <div className="proposal-panel review-card review-result" role="region" aria-label="Result of the proposal">
        <p className="review-result-summary" role="status">{childResultSummary(result)}</p>
        {result.created.length > 0 && (
          <ul className="review-created">
            {result.created.map((child) => <li key={child.itemId}><button type="button" className="text-link" onClick={() => onSelectItem?.(child.itemId)}>{child.title}</button></li>)}
          </ul>
        )}
        {result.failed.length > 0 && <ul className="review-problem-list">{result.failed.map((failure) => <li key={failure.proposalId}>Could not create “{failure.proposalId}”: {failure.reason}</li>)}</ul>}
        {(result.relationshipsSkipped?.length ?? 0) > 0 && <p className="review-rationale">{plural(result.relationshipsSkipped!.length, 'relationship')} skipped: {result.relationshipsSkipped!.map((skip) => skip.reason).join('; ')}</p>}
      </div>
    );
  }
  const open = result.conflicted.filter((conflict) => !kept.includes(conflict.sectionId));
  return (
    <div className="proposal-panel review-card review-result" role="region" aria-label="Result of the proposal">
      <p className="review-result-summary" role="status">{documentResultSummary(result)}</p>
      {(result.titleApplied || result.statusApplied) && <p className="review-rationale">{[result.titleApplied && 'Title updated', result.statusApplied && 'Status updated'].filter(Boolean).join(' · ')}</p>}
      {result.warnings?.map((warning) => <p key={warning} className="review-rationale">{warning}</p>)}
      {result.conflicted.length > 0 && (
        <>
          <p className="review-conflict-intro">{open.length > 0 ? 'Somebody changed these sections while you were reviewing, so they were not applied:' : 'All conflicts are resolved.'}</p>
          <ul className="review-conflicts">
            {open.map((conflict) => (
              <ConflictRow key={conflict.sectionId} conflict={conflict} proposed={proposedMarkdown(messages, result.toolCallId, conflict.sectionId)} disabled={disabled}
                onRedo={onSend ? () => { onSend(`Please redo section "${conflict.heading}" based on the current version.`); setKept((current) => [...current, conflict.sectionId]); } : undefined}
                onKeep={() => setKept((current) => [...current, conflict.sectionId])} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Shows the latest `lastApply` once, at the end of the conversation, until the user sends another message
 * (`userMessages` is the number of user messages in the transcript).
 */
export function useResultVisibility(result: LastApply | null, userMessages: number): boolean {
  const key = result ? `${result.toolCallId ?? ''}|${result.at ?? ''}|${JSON.stringify(result)}` : '';
  const [seen, setSeen] = useState<{ key: string; users: number }>({ key, users: userMessages });
  if (seen.key !== key) setSeen({ key, users: userMessages });
  return Boolean(result) && userMessages <= (seen.key === key ? seen.users : userMessages);
}
