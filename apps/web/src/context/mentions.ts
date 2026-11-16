import type { ItemSummary } from '../api';

export interface MentionCandidate { id: string; title: string; typeLabel: string }

export interface MentionTrigger { start: number; end: number; query: string }

const MAX_QUERY = 60;

/** The `@query` the caret is in (the `@` must start the message or follow whitespace), if any. */
export function findMention(value: string, caret: number): MentionTrigger | undefined {
  const before = value.slice(0, caret);
  const found = /(^|\s)@([^\n@]{0,60})$/.exec(before);
  if (!found || found[2].length > MAX_QUERY) return undefined;
  const start = found.index + found[1].length;
  return { start, end: caret, query: found[2] };
}

export function matchMentions(items: readonly MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items.slice(0, limit);
  const starts: MentionCandidate[] = [];
  const contains: MentionCandidate[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    if (title.startsWith(needle)) starts.push(item);
    else if (title.includes(needle)) contains.push(item);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** `@[Title](item:<id>)`: readable in the transcript and carries the id the agent needs for `get_item_context`. */
export function mentionText(item: Pick<MentionCandidate, 'id' | 'title'>): string {
  const title = (item.title || 'Untitled item').replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return `@[${title}](item:${item.id})`;
}

export function insertMention(value: string, trigger: MentionTrigger, item: Pick<MentionCandidate, 'id' | 'title'>): { value: string; caret: number } {
  const inserted = `${mentionText(item)} `;
  const next = value.slice(0, trigger.start) + inserted + value.slice(trigger.end);
  return { value: next, caret: trigger.start + inserted.length };
}

const MENTION = /@\[([^\]]*)\]\(item:[^)\s]+\)/g;

/** Shows mentions as `@Title` (for the transcript); the stored / sent text keeps the full form. */
export function displayMentions(text: string): string {
  return text.replace(MENTION, (_whole, title: string) => `@${title}`);
}

/** Ids of the items mentioned in a message. */
export function mentionedItemIds(text: string): string[] {
  return [...text.matchAll(/@\[[^\]]*\]\(item:([^)\s]+)\)/g)].map((match) => match[1]);
}

export function toMentionCandidates(items: readonly ItemSummary[], typeLabels: Record<string, string>, excludeId?: string): MentionCandidate[] {
  return items.filter((item) => item.id !== excludeId).map((item) => ({ id: item.id, title: item.title, typeLabel: typeLabels[item.type] ?? item.type }));
}
