import { chat } from './fixtures';
import type { Page } from '@playwright/test';
import { scriptGateway, type ScriptedResponse } from './fake-gateway';

let counter = 0;
/** A marker that is unique per test and ends up in the user message, so the fake gateway serves the right script. */
export const newMarker = () => `e2e-${Date.now().toString(36)}-${(counter += 1)}-${Math.random().toString(36).slice(2, 6)}`;

export async function scriptedRun(marker: string, responses: ScriptedResponse[]): Promise<void> {
  await scriptGateway(marker, responses);
}

export async function sendToAgent(page: Page, text: string): Promise<void> {
  await chat(page).getByRole('textbox', { name: 'Message the refinement agent' }).fill(text);
  await chat(page).getByRole('button', { name: 'Send message' }).click();
}

export const askCard = (page: Page) => page.getByRole('region', { name: 'The agent asks' });
export const reviewCard = (page: Page) => chat(page).getByRole('region').filter({ has: page.getByRole('button', { name: /^(Apply \d+ sections?|Create \d+ items?|Reject proposal)$/ }) });

export const setSessionTitle = (title: string, id = 'call_title'): ScriptedResponse => ({ tool_calls: [{ id, name: 'set_session_title', arguments: { title } }] });
export const toolCall = (name: string, args: unknown, id: string): ScriptedResponse => ({ tool_calls: [{ id, name, arguments: args }] });
