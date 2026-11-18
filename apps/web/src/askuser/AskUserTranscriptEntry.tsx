import type { TranscriptEntry } from '../run';
import { AskUserSummary } from './AskUserSummary';
import { parseArgs, parseResult } from './askUserModel';

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;

/**
 * The transcript form of an `ask_user` call: the answered summary (also after hydration, from the tool call arguments
 * and the tool result message) or the dismissed note. A pending call renders nothing (the card is shown instead).
 */
export function AskUserTranscriptEntry({ entry }: { entry: ToolEntry }) {
  const args = parseArgs(entry.args);
  const result = parseResult(entry.result);
  if (args && result) return <AskUserSummary args={args} result={result} />;
  return isDismissed(entry) ? <AskUserSummary args={args} dismissed /> : null;
}

/** Dismissed: the user replied in chat, so the call has no result (live) or only the server's synthetic "skipped" text (hydrated). */
function isDismissed(entry: ToolEntry): boolean {
  return entry.status === 'skipped' || (entry.status === 'done' && Boolean(entry.result?.trim()) && parseResult(entry.result) === null);
}

/** An `ask_user` entry that has something to show in the transcript. */
export const showsAskUserSummary = (entry: ToolEntry): boolean => parseResult(entry.result) !== null || isDismissed(entry);
