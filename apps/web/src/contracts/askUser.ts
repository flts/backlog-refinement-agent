import { z } from 'zod';
import { nonEmpty, uniqueBy } from './primitives';

export const ASK_USER_TOOL_NAME = 'ask_user';

export const AskUserOptionSchema = z.strictObject({
  label: nonEmpty,
  description: z.string().optional(),
});

export const AskUserQuestionSchema = z.strictObject({
  id: nonEmpty,
  /** Stepper tab label, at most 24 characters. */
  header: nonEmpty.max(24),
  question: nonEmpty,
  rationale: z.string().optional(),
  relatedSection: z.string().optional(),
  options: z.array(AskUserOptionSchema).min(1).max(4),
  /** Zero-based index into `options`. */
  recommended: z.number().int().min(0).max(3).optional(),
  multiSelect: z.boolean().default(false),
}).superRefine((question, ctx) => {
  if (question.recommended !== undefined && question.recommended >= question.options.length) {
    ctx.addIssue({ code: 'custom', path: ['recommended'], message: 'recommended must be an index into options.' });
  }
});

export const AskUserArgsSchema = z.strictObject({
  questions: z.array(AskUserQuestionSchema).min(1).max(3),
}).superRefine((args, ctx) => uniqueBy(args.questions, (q) => q.id, ctx, 'questions', 'Question ids must be unique.'));

export const AskUserAnswerSchema = z.strictObject({
  questionId: nonEmpty,
  selected: z.array(z.string()),
  freeform: z.string().optional(),
  skipped: z.boolean(),
});

/** `dismissed` exists for completeness; the SPA sends only a user message when the composer is used instead. */
export const AskUserResultSchema = z.strictObject({
  status: z.enum(['answered', 'skipped', 'dismissed']),
  answers: z.array(AskUserAnswerSchema),
});

export type AskUserOption = z.infer<typeof AskUserOptionSchema>;
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
export type AskUserArgs = z.infer<typeof AskUserArgsSchema>;
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>;
export type AskUserResult = z.infer<typeof AskUserResultSchema>;
