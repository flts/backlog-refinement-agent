import { z } from 'zod';
import { agentIntents, nonEmpty } from './primitives';

export const SUGGEST_NEXT_ACTIONS_TOOL_NAME = 'suggest_next_actions';
export const SET_SESSION_TITLE_TOOL_NAME = 'set_session_title';

export const NextActionSchema = z.strictObject({
  id: nonEmpty,
  label: nonEmpty.max(60),
  intent: z.enum([...agentIntents, 'message']),
  prompt: z.string().optional(),
}).superRefine((action, ctx) => {
  if (action.intent === 'message' && action.prompt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'A message action needs a prompt.' });
  }
});

export const SuggestNextActionsArgsSchema = z.strictObject({
  actions: z.array(NextActionSchema).max(3),
});

export const SetSessionTitleArgsSchema = z.strictObject({
  title: nonEmpty.max(60),
});

export type NextAction = z.infer<typeof NextActionSchema>;
export type SuggestNextActionsArgs = z.infer<typeof SuggestNextActionsArgsSchema>;
export type SetSessionTitleArgs = z.infer<typeof SetSessionTitleArgsSchema>;
