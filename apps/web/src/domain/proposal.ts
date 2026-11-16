import { z } from "zod";
import { backlogItemTypeSchema, QualityAssessmentSchema } from "./backlog-item";
import { relationshipTypes } from "./relationship";

const nonEmptyString = z.string().trim().min(1);

export const ClarificationQuestionSchema = z.object({
  id: nonEmptyString,
  text: nonEmptyString,
  importance: z.enum(["blocking", "important", "non-blocking"]),
  relatedField: nonEmptyString.optional(),
  rationale: z.string().optional(),
});

export const SectionUpdateSchema = z.object({
  heading: nonEmptyString,
  markdown: z.string(),
  mode: z.enum(["replace", "append"]).default("replace"),
});

export const AssessmentProposalSchema = z.object({
  id: nonEmptyString,
  kind: z.literal("assessment"),
  itemId: nonEmptyString,
  generatedAt: z.string().datetime(),
  summary: nonEmptyString,
  questions: z.array(ClarificationQuestionSchema).default([]),
  suggestedTitle: nonEmptyString.optional(),
  sectionUpdates: z.array(SectionUpdateSchema).default([]),
  suggestedStatus: z.enum(["ready", "ready-with-open-questions"]).optional(),
  quality: QualityAssessmentSchema.optional(),
});

const ProposedChildSchema = z.object({
  proposalId: nonEmptyString,
  type: backlogItemTypeSchema,
  title: nonEmptyString,
  description: z.string().default(""),
});

export const ProposedRelationshipSchema = z.object({
  sourceRef: nonEmptyString,
  targetRef: nonEmptyString,
  type: z.enum(relationshipTypes),
});

export const DecompositionProposalSchema = z.object({
  id: nonEmptyString,
  kind: z.literal("decomposition"),
  parentItemId: nonEmptyString,
  generatedAt: z.string().datetime(),
  rationale: nonEmptyString,
  children: z.array(ProposedChildSchema).default([]),
  relationships: z.array(ProposedRelationshipSchema).default([]),
}).superRefine((proposal, context) => {
  const childIds = new Set<string>();
  for (const [index, child] of proposal.children.entries()) {
    if (child.proposalId === proposal.parentItemId || childIds.has(child.proposalId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["children", index, "proposalId"],
        message: "Child proposal identifiers must be unique and distinct from the parent item.",
      });
    }
    childIds.add(child.proposalId);
  }
  const refs = new Set([proposal.parentItemId, ...childIds]);
  proposal.relationships.forEach((relationship, index) => {
    if (!refs.has(relationship.sourceRef) || !refs.has(relationship.targetRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relationships", index],
        message: "Relationship endpoints must refer to the parent item or a proposed child.",
      });
    }
  });
});

export const RefinementProposalSchema = z.union([
  AssessmentProposalSchema,
  DecompositionProposalSchema,
]);

export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
export type AssessmentProposal = z.infer<typeof AssessmentProposalSchema>;
export type ProposedChild = z.infer<typeof ProposedChildSchema>;
export type ProposedRelationship = z.infer<typeof ProposedRelationshipSchema>;
export type DecompositionProposal = z.infer<typeof DecompositionProposalSchema>;
export type RefinementProposal = z.infer<typeof RefinementProposalSchema>;
