import type { AgentIntent, ItemType } from '../contracts';
import type { Interrupt } from './events';
import type { RunInputBuilder } from './runInput';
import type { AgentClient, RunHandlers, RunOutcome } from './types';

export type SendMessageResult =
  | { status: 'sent'; outcome: RunOutcome; cancelOutcome?: RunOutcome }
  /** The cancel run failed, so the message was NOT sent (it would be ignored next to a pending interrupt). */
  | { status: 'cancelFailed'; cancelOutcome: RunOutcome };

/**
 * Spike #8: a user message next to a pending approval is ignored by the server. Cancel every interrupt first (a resume
 * run without model call), then send the message in a separate run. Without pending interrupts it is a plain run.
 * Wrap the call in `ThreadRunQueue.run` so both runs stay serialised.
 */
export async function sendMessageCancellingPending(
  client: AgentClient,
  builder: RunInputBuilder,
  params: { text: string; interrupts?: readonly Pick<Interrupt, 'id'>[]; intent?: AgentIntent; childType?: ItemType },
  handlers?: RunHandlers,
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  const interrupts = params.interrupts ?? [];
  if (interrupts.length === 0) {
    return { status: 'sent', outcome: await client.run(builder.userMessage(params.text, params.intent, params.childType), handlers, signal) };
  }
  const { cancel, message } = builder.cancelPendingThenMessage(interrupts, params.text, params.intent, params.childType);
  const cancelOutcome = await client.run(cancel, handlers, signal);
  if (cancelOutcome.status !== 'success' && cancelOutcome.status !== 'cancelled') return { status: 'cancelFailed', cancelOutcome };
  return { status: 'sent', cancelOutcome, outcome: await client.run(message, handlers, signal) };
}
