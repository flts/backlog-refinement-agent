import type { ProposedChild, SectionChange } from '../contracts';
import { readChildProposal, readDocumentProposal } from '../review/proposal';
import type { ReviewInterrupt } from './runReducer';

export const REPROPOSE_HEADER = 'Please re-propose these changes, keeping my edits:';
export const REPROPOSE_PLAIN = 'Please re-propose these changes.';
/** Upper bound of the fenced list in the re-propose message (the whole run request must stay far below the server's body limit). */
export const REPROPOSE_MAX_CHARS = 8000;

export interface ExpiredItem {
  id: string;
  label: string;
  /** "replace"/"append" for sections, the item type for children. */
  kind: string;
  markdown: string;
  edited: boolean;
  /** Set for sections, so the card can diff them against the document. */
  section?: SectionChange;
}

export interface ExpiredSummary {
  kind: 'document' | 'children';
  interruptId: string;
  /** What the agent proposed (the summary or rationale). */
  heading: string;
  childType?: string;
  /** What the user had accepted. Empty when everything was rejected. */
  items: ExpiredItem[];
  total: number;
  /** The accepted new title / status of a document proposal. */
  title?: string;
  status?: string;
}

const statusText = (status: string) => (status === 'ready' ? 'Ready' : 'Ready · questions');

/** What the user had decided on an expired proposal, or null without a recorded decision or when the arguments cannot be read. */
export function summarizeExpired(interrupt: ReviewInterrupt): ExpiredSummary | null {
  const { draft } = interrupt;
  if (!draft) return null;
  const everything = draft.approved && !draft.editedArgs;
  const document = readDocumentProposal(interrupt.args);
  if (document) {
    const edited = draft.approved ? (draft.editedArgs ? readDocumentProposal(draft.editedArgs) : document) : null;
    const original = new Map(document.sections.map((section) => [section.id, section]));
    const items = (edited?.sections ?? []).map((section): ExpiredItem => ({
      id: section.id, label: section.heading, kind: section.mode, markdown: section.markdown, section,
      edited: !everything && original.get(section.id)?.markdown !== section.markdown,
    }));
    return {
      kind: 'document', interruptId: interrupt.id, heading: document.summary, items, total: document.sections.length,
      ...(edited?.suggestedTitle ? { title: edited.suggestedTitle } : {}),
      ...(edited?.suggestedStatus ? { status: statusText(edited.suggestedStatus) } : {}),
    };
  }
  const children = readChildProposal(interrupt.args);
  if (children) {
    const edited = draft.approved ? (draft.editedArgs ? readChildProposal(draft.editedArgs) : children) : null;
    const original = new Map(children.children.map((child) => [child.proposalId, child]));
    const items = (edited?.children ?? []).map((child: ProposedChild): ExpiredItem => {
      const before = original.get(child.proposalId);
      return {
        id: child.proposalId, label: child.title, kind: children.childType, markdown: child.markdown,
        edited: !everything && (before?.title !== child.title || before?.markdown !== child.markdown),
      };
    });
    return { kind: 'children', interruptId: interrupt.id, heading: children.rationale, childType: children.childType, items, total: children.children.length };
  }
  return null;
}

/** True when the summaries hold something the user would want to keep (accepted parts, a new title or status). */
export const hasKeptContent = (summaries: readonly ExpiredSummary[]) => summaries.some((summary) => summary.items.length > 0 || summary.title || summary.status);

const indent = (text: string) => text.split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');

function blocksOf(summaries: readonly ExpiredSummary[]): string[] {
  const blocks: string[] = [];
  for (const summary of summaries) {
    if (summary.title) blocks.push(`- Rename the item to "${summary.title}"`);
    if (summary.status) blocks.push(`- Set the status to ${summary.status}`);
    for (const item of summary.items) {
      const head = summary.kind === 'document'
        ? `- Section "${item.label}" (${item.kind}${item.edited ? ', edited by me' : ''})`
        : `- ${item.kind} item "${item.label}"${item.edited ? ' (edited by me)' : ''}`;
      blocks.push(item.markdown.trim() ? `${head}\n${indent(item.markdown.trim())}` : head);
    }
  }
  return blocks;
}

export interface RepromposeMessage { text: string; truncated: boolean }

/**
 * The message that asks the agent to propose again while keeping the user's accepted/edited parts: the header and a
 * fenced Markdown list. The list is bounded (`limit` characters); what does not fit is cut and announced after the fence.
 * Returns null when there is nothing to keep.
 */
export function buildRepromposeMessage(interrupts: readonly ReviewInterrupt[], limit = REPROPOSE_MAX_CHARS): RepromposeMessage | null {
  const summaries = interrupts.flatMap((interrupt) => { const summary = summarizeExpired(interrupt); return summary ? [summary] : []; });
  if (!hasKeptContent(summaries)) return null;
  const blocks = blocksOf(summaries);
  const kept: string[] = [];
  let cut = false;
  for (const block of blocks) {
    const used = kept.length > 0 ? kept.join('\n').length + 1 : 0;
    if (used + block.length <= limit) { kept.push(block); continue; }
    // A long entry is cut when a useful part of it still fits; everything after it is left out.
    const room = limit - used;
    if (room >= 120) kept.push(`${block.slice(0, room - 1)}…`);
    cut = true;
    break;
  }
  const omitted = blocks.length - kept.length;
  const list = kept.join('\n');
  const longestRun = Math.max(0, ...(list.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const note = cut ? `\n\nNote: the list was shortened to ${limit} characters${omitted > 0 ? ` (${omitted} more ${omitted === 1 ? 'entry was' : 'entries were'} left out or cut)` : ''}.` : '';
  return { text: `${REPROPOSE_HEADER}\n\n${fence}markdown\n${list}\n${fence}${note}`, truncated: cut };
}
