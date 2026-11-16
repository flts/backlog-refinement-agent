import type { Message } from '@ag-ui/core';
import {
  ForwardedPropsSchema,
  initialAgentState,
  AskUserResultSchema,
  ResumeEntrySchema,
  type AgentIntent,
  type AskUserResult,
  type ItemType,
  type ResumeEntry,
} from '../contracts';
import { askUserTool } from './askUserTool';
import type { Interrupt } from './events';
import type { RunRequest } from './types';

/** Texts of runs that only carry an intent (`/continue`, chips). The agent-service ignores runs without messages. */
export const intentPrompts: Record<AgentIntent, string> = {
  refine: 'Refine this item.',
  continue: 'Continue.',
  breakdown: 'Break this item down into child items.',
  assess: 'Assess the quality of this item.',
};

/** `forwardedProps` for a run; `{}` without intent. Throws when invalid or longer than 512 serialized characters. */
export function buildForwardedProps(intent?: AgentIntent, childType?: ItemType): RunRequest['forwardedProps'] {
  if (!intent) return {};
  return ForwardedPropsSchema.parse({ intent, ...(childType ? { childType } : {}) });
}

export type ResumeDecision =
  | { interruptId: string; approved: boolean; /** FULL replacement of the tool arguments (see `editedArgsFor`). */ editedArgs?: Record<string, unknown> }
  | { interruptId: string; cancelled: true };

/**
 * `editedArgs` must contain ALL argument keys of the proposal (spike #3): the original arguments of the interrupt with
 * the accepted/edited parts replaced. Never send only the changed keys.
 */
export function editedArgsFor(interrupt: Pick<Interrupt, 'args'>, replacements: Record<string, unknown>): Record<string, unknown> {
  return { ...interrupt.args, ...replacements };
}

export interface RunInputContext {
  threadId: string;
  projectId: string;
  itemId: string;
  itemType?: ItemType;
  /** Test seam; defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/**
 * Builds the `RunRequest`s of one thread. Every request has `threadId` + `runId`, a fresh state with `preview: null`
 * (spike #6), `tools: [ask_user]` (except hydrate) and no `context[]`. Only NEW messages are sent: the
 * agent-service stores the transcript (the stored history wins over client replays).
 */
export class RunInputBuilder {
  private readonly newId: () => string;

  constructor(private readonly context: RunInputContext) {
    this.newId = context.newId ?? (() => globalThis.crypto.randomUUID());
  }

  private request(parts: { messages?: Message[]; resume?: ResumeEntry[]; forwardedProps?: RunRequest['forwardedProps']; tools?: boolean }): RunRequest {
    const { threadId, projectId, itemId, itemType } = this.context;
    return {
      threadId,
      runId: this.newId(),
      messages: parts.messages ?? [],
      state: initialAgentState(projectId, itemId, itemType),
      tools: parts.tools === false ? [] : [askUserTool],
      forwardedProps: parts.forwardedProps ?? {},
      ...(parts.resume ? { resume: parts.resume } : {}),
    };
  }

  private userMessageEntry(text: string): Message {
    if (!text.trim()) throw new Error('A user message must not be empty.');
    return { id: this.newId(), role: 'user', content: text };
  }

  /** A new user message, optionally with an intent (slash command, chip). */
  userMessage(text: string, intent?: AgentIntent, childType?: ItemType): RunRequest {
    return this.request({ messages: [this.userMessageEntry(text)], forwardedProps: buildForwardedProps(intent, childType) });
  }

  /** An intent-only run (`/continue`, a chip without prompt). Sends the default prompt of the intent as user message. */
  continue(intent: AgentIntent = 'continue', childType?: ItemType): RunRequest {
    return this.userMessage(intentPrompts[intent], intent, childType);
  }

  /**
   * The answer to a pending `ask_user`: ONLY the tool message (spike #10), never an additional user message
   * (MAF would overwrite a `dismissed` result with its own synthetic text).
   */
  askUserAnswer(toolCallId: string, result: AskUserResult): RunRequest {
    const parsed = AskUserResultSchema.parse(result);
    return this.request({ messages: [{ id: this.newId(), role: 'tool', toolCallId, content: JSON.stringify(parsed) }] });
  }

  /** The arguments of `ask_user` were invalid: answer the call with an error tool message so the model can retry. */
  askUserInvalid(toolCallId: string, reason: string): RunRequest {
    return this.request({ messages: [{ id: this.newId(), role: 'tool', toolCallId, content: reason, error: reason }] });
  }

  /**
   * The user typed in the composer instead of answering: only a user message (spike #9). The server injects the
   * "skipped" tool result, so the question ids are carried in a prefix for the model.
   */
  askUserDismissedWithMessage(text: string, questionIds: readonly string[] = [], intent?: AgentIntent): RunRequest {
    const prefix = questionIds.length > 0 ? `[dismissed question ${questionIds.join(', ')}]` : '[dismissed question]';
    return this.request({ messages: [this.userMessageEntry(`${prefix} ${text}`)], forwardedProps: buildForwardedProps(intent) });
  }

  /** Decisions for ALL pending interrupts (the server requires an entry for every interruptId). */
  resume(decisions: readonly ResumeDecision[]): RunRequest {
    if (decisions.length === 0) throw new Error('resume needs at least one decision.');
    const resume = decisions.map((decision): ResumeEntry => {
      const entry =
        'cancelled' in decision
          ? { interruptId: decision.interruptId, status: 'cancelled' as const }
          : {
              interruptId: decision.interruptId,
              status: 'resolved' as const,
              payload: { approved: decision.approved, ...(decision.editedArgs ? { editedArgs: decision.editedArgs } : {}) },
            };
      return ResumeEntrySchema.parse(entry);
    });
    return this.request({ resume });
  }

  /**
   * A user message while an approval is pending (spike #8): the message would be ignored next to a pending interrupt, so
   * first cancel every interrupt (a resume run, no model call), then send the message in a separate run.
   * Run them in order and only start `message` when `cancel` succeeded (`sendMessageCancellingPending`).
   */
  cancelPendingThenMessage(interrupts: readonly Pick<Interrupt, 'id'>[], text: string, intent?: AgentIntent, childType?: ItemType): { cancel: RunRequest; message: RunRequest } {
    return {
      cancel: this.resume(interrupts.map((interrupt) => ({ interruptId: interrupt.id, cancelled: true as const }))),
      message: this.userMessage(text, intent, childType),
    };
  }

  /** Replays the stored thread without a model call: `messages: []`, no `resume`, no tools. */
  hydrate(): RunRequest {
    return this.request({ tools: false });
  }
}
