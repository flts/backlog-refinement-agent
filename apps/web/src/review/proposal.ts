import {
  PROPOSE_CHILD_ITEMS_TOOL_NAME, PROPOSE_DOCUMENT_CHANGES_TOOL_NAME, ProposeChildItemsArgsSchema, ProposeDocumentChangesArgsSchema, SectionChangeSchema, SuggestedStatusSchema,
  type DocumentPreview, type ProposeChildItemsArgs, type ProposeDocumentChangesArgs, type SectionChange,
} from '../contracts';
import { applySectionUpdates, normalizeHeading, splitSections } from '../domain/document';
import type { RunState, TranscriptEntry } from '../run';
import { parsePartialProposal } from './partialArgs';

/** The spike's tool used `base_version`; the contract says `baseVersion`. Both are read, the key of the interrupt is kept when sending. */
function withContractKeys(args: Record<string, unknown>): Record<string, unknown> {
  if (args.baseVersion === undefined && args.base_version !== undefined) {
    const { base_version: baseVersion, ...rest } = args;
    return { ...rest, baseVersion };
  }
  return args;
}

/** Strictly validated arguments of `propose_document_changes`, or null when they cannot be reviewed safely. */
export function readDocumentProposal(args: unknown): ProposeDocumentChangesArgs | null {
  if (!args || typeof args !== 'object') return null;
  const parsed = ProposeDocumentChangesArgsSchema.safeParse(withContractKeys(args as Record<string, unknown>));
  return parsed.success ? parsed.data : null;
}

export function readChildProposal(args: unknown): ProposeChildItemsArgs | null {
  const parsed = ProposeChildItemsArgsSchema.safeParse(args);
  return parsed.success ? parsed.data : null;
}

/** Lenient read for the predictive preview: unknown keys and invalid sections are dropped instead of failing. */
export function readPreviewArgs(args: unknown): DocumentPreview | null {
  if (!args || typeof args !== 'object') return null;
  const raw = withContractKeys(args as Record<string, unknown>);
  const sections = Array.isArray(raw.sections)
    ? raw.sections.flatMap((section): SectionChange[] => { const parsed = SectionChangeSchema.safeParse(section); return parsed.success ? [parsed.data] : []; })
    : [];
  const status = SuggestedStatusSchema.safeParse(raw.suggestedStatus);
  return {
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    ...(typeof raw.suggestedTitle === 'string' && raw.suggestedTitle ? { suggestedTitle: raw.suggestedTitle } : {}),
    ...(status.success ? { suggestedStatus: status.data } : {}),
    sections,
  };
}

export interface ProposalForPreview {
  proposal: DocumentPreview;
  /** `streaming`: the agent is still writing; `review`: waiting for the user's decision. */
  status: 'streaming' | 'review';
}

/**
 * What the Document tab shows as track changes. A stale `preview` (cancelled or expired proposal, spike #6) is ignored:
 * it only counts while a run is streaming it or while a live interrupt waits for review.
 */
export function proposalForPreview(run: Pick<RunState, 'phase' | 'interrupts' | 'agentState' | 'messages'>): ProposalForPreview | null {
  if (run.phase === 'awaitingReview') {
    const interrupt = run.interrupts.find((entry) => !entry.expired && entry.toolName === PROPOSE_DOCUMENT_CHANGES_TOOL_NAME);
    const proposal = interrupt ? readPreviewArgs(interrupt.args) : null;
    if (proposal && proposal.sections.length > 0) return { proposal, status: 'review' };
    const fromState = run.agentState.preview;
    return interrupt && fromState && fromState.sections.length > 0 ? { proposal: fromState, status: 'review' } : null;
  }
  if (run.phase !== 'running') return null;
  const fromState = run.agentState.preview;
  if (fromState && fromState.sections.length > 0) return { proposal: fromState, status: 'streaming' };
  const streaming = [...run.messages].reverse().find((entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool' && entry.toolName === PROPOSE_DOCUMENT_CHANGES_TOOL_NAME && entry.status === 'running');
  const partial = streaming ? parsePartialProposal(streaming.argsText) : null;
  return partial && partial.sections.length > 0 ? { proposal: partial, status: 'streaming' } : null;
}

export interface SectionDiffInput {
  before: string;
  after: string;
  isNew: boolean;
  warnings: string[];
}

/** Current vs. proposed body of one section, computed with the same merge rules as the editor (the server merge is authoritative). */
export function sectionDiff(document: string, change: Pick<SectionChange, 'heading' | 'markdown' | 'mode'>): SectionDiffInput {
  const key = normalizeHeading(change.heading);
  const existing = splitSections(document).sections.find((section) => normalizeHeading(section.heading) === key);
  const before = existing?.body ?? '';
  const applied = applySectionUpdates(`## ${existing?.heading ?? change.heading}\n${before}`, [change]);
  const after = applied.document.split('\n').slice(1).join('\n').trim();
  return { before, after, isNew: !existing, warnings: applied.warnings };
}

export interface SimilarItem { id: string; title: string; score: number }

export const OVERLAP_THRESHOLD = 0.8;

/** `find_similar_items` hits of the latest user turn at or above the threshold (the item itself excluded). */
export function similarItemsFrom(messages: readonly TranscriptEntry[], currentItemId?: string, threshold = OVERLAP_THRESHOLD): SimilarItem[] {
  const lastUser = messages.map((entry) => entry.kind).lastIndexOf('user');
  const found = new Map<string, SimilarItem>();
  for (const entry of messages.slice(lastUser + 1)) {
    if (entry.kind !== 'tool' || entry.toolName !== 'find_similar_items' || !entry.result) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(entry.result); } catch { continue; }
    const items = parsed && typeof parsed === 'object' ? (parsed as { items?: unknown }).items : undefined;
    if (!Array.isArray(items)) continue;
    for (const hit of items) {
      if (!hit || typeof hit !== 'object') continue;
      const { id, title, score } = hit as Record<string, unknown>;
      if (typeof id === 'string' && typeof title === 'string' && typeof score === 'number' && score >= threshold && id !== currentItemId) found.set(id, { id, title, score });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}

export { PROPOSE_CHILD_ITEMS_TOOL_NAME, PROPOSE_DOCUMENT_CHANGES_TOOL_NAME };
