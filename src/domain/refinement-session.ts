import { z } from "zod";
import { OpenQuestionSchema } from "./backlog-item";
import { DomainError } from "./errors";

const nonEmptyString = z.string().trim().min(1);

export const ConversationMessageSchema = z.object({
  id: nonEmptyString,
  role: z.enum(["user", "agent", "system"]),
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const PendingQuestionSchema = z.object({
  id: nonEmptyString,
  text: nonEmptyString,
  relatedItemId: nonEmptyString.optional(),
  importance: z.enum(["blocking", "important", "non-blocking"]).optional(),
  relatedField: nonEmptyString.optional(),
  rationale: z.string().optional(),
});

export const RefinementSessionSchema = z.object({
  id: nonEmptyString,
  backlogItemId: nonEmptyString,
  conversation: z.array(ConversationMessageSchema).default([]),
  pendingQuestions: z.array(PendingQuestionSchema).default([]),
  status: z.enum(["active", "paused", "complete"]).default("active"),
  forceGeneration: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;
export type RefinementSession = z.infer<typeof RefinementSessionSchema>;

export function getUnansweredQuestions(
  questions: readonly z.infer<typeof OpenQuestionSchema>[],
): z.infer<typeof OpenQuestionSchema>[] {
  return questions.filter((question) => question.status === "open");
}

export function transitionSessionStatus(
  session: RefinementSession,
  nextStatus: RefinementSession["status"],
  updatedAt: string,
): RefinementSession {
  const transitions: Record<RefinementSession["status"], readonly RefinementSession["status"][]> = {
    active: ["paused", "complete"],
    paused: ["active", "complete"],
    complete: [],
  };
  if (session.status === nextStatus) return session;
  if (!transitions[session.status].includes(nextStatus)) {
    throw new DomainError(
      `Cannot transition refinement session from ${session.status} to ${nextStatus}.`,
      "INVALID_SESSION_TRANSITION",
    );
  }
  return { ...session, status: nextStatus, updatedAt };
}
