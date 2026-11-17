import { FAKE_GATEWAY_URL } from './env';

export interface ScriptedToolCall { name: string; arguments: unknown; id?: string }
export interface ScriptedResponse { content?: string; tool_calls?: ScriptedToolCall[] }

/**
 * Registers a scripted conversation for requests whose messages contain `marker` (use a per-test unique marker, for
 * example in the user message), so tests can run in parallel against one fake gateway.
 */
export async function scriptGateway(marker: string, responses: ScriptedResponse[]): Promise<void> {
  const response = await fetch(`${FAKE_GATEWAY_URL}/fake/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ match: marker, responses }),
  });
  if (!response.ok) throw new Error(`POST /fake/script failed: ${response.status} ${await response.text()} (is FAKE_GATEWAY_CONTROL=true set?)`);
}

export const askUser = (questions: unknown[], id = 'call_ask') => ({ tool_calls: [{ id, name: 'ask_user', arguments: { questions } }] });
