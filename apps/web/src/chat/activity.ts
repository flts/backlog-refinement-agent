import { ASK_USER_TOOL_NAME, PROPOSE_CHILD_ITEMS_TOOL_NAME, PROPOSE_DOCUMENT_CHANGES_TOOL_NAME, RECORD_QUALITY_ASSESSMENT_TOOL_NAME, SET_SESSION_TITLE_TOOL_NAME, SUGGEST_NEXT_ACTIONS_TOOL_NAME } from '../contracts';
import { SEARCH_SOURCES_TOOL_NAME, type TranscriptEntry } from '../run';

export type ActivityRowEntry = Extract<TranscriptEntry, { kind: 'step' | 'tool' }>;

/** Tools that have their own UI (cards, chips, session title) and therefore no timeline row. */
const hiddenTools = new Set<string>([ASK_USER_TOOL_NAME, SET_SESSION_TITLE_TOOL_NAME, SUGGEST_NEXT_ACTIONS_TOOL_NAME, RECORD_QUALITY_ASSESSMENT_TOOL_NAME]);

export const isActivityEntry = (entry: TranscriptEntry): entry is ActivityRowEntry =>
  entry.kind === 'step' || (entry.kind === 'tool' && !hiddenTools.has(entry.toolName));

function queryOf(args: unknown): string | undefined {
  const query = args && typeof args === 'object' ? (args as { query?: unknown }).query : undefined;
  return typeof query === 'string' && query.trim() ? query.trim() : undefined;
}

const humanize = (name: string) => name.replace(/[_-]+/g, ' ').trim();

/** Friendly row label; the `running` form is used while the call is in flight. */
export function activityLabel(entry: ActivityRowEntry): string {
  if (entry.kind === 'step') return entry.name;
  const running = entry.status === 'running';
  switch (entry.toolName) {
    case SEARCH_SOURCES_TOOL_NAME: {
      const query = queryOf(entry.args);
      return `${running ? 'Searching' : 'Searched'} sources${query ? ` for “${query}”` : ''}`;
    }
    case 'find_similar_items': return running ? 'Checking for similar items' : 'Checked for similar items';
    case 'get_item_context': return running ? 'Reading the item' : 'Read the item';
    case 'get_project_guidance': return running ? 'Loading guidance' : 'Loaded guidance';
    case 'get_pinned_sources': return running ? 'Reading pinned sources' : 'Read pinned sources';
    case PROPOSE_DOCUMENT_CHANGES_TOOL_NAME: return running ? 'Preparing changes' : 'Prepared changes for review';
    case PROPOSE_CHILD_ITEMS_TOOL_NAME: return running ? 'Preparing child items' : 'Prepared child items for review';
    default: return `${running ? 'Using' : 'Used'} ${humanize(entry.toolName)}`;
  }
}

export const statusText: Record<'running' | 'done' | 'error' | 'cancelled' | 'skipped' | 'pending', string> = {
  running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Stopped', skipped: 'Skipped', pending: 'Waiting for you',
};
