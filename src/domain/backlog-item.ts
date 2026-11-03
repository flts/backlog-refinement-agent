import { z } from "zod";

export const backlogItemTypes = [
  "capability",
  "feature",
  "user-story",
  "enabler",
] as const;

export const backlogItemStatuses = [
  "draft",
  "refining",
  "ready",
  "ready-with-open-questions",
  "complete",
] as const;

export const knowledgeStatuses = ["known", "assumed", "unknown", "unclear"] as const;
export const contextSources = ["user", "existing-item", "parent-item", "agent"] as const;

const nonEmptyString = z.string().trim().min(1);

export const ContextValueSchema = z.object({
  key: nonEmptyString,
  value: z.string(),
  knowledgeStatus: z.enum(knowledgeStatuses),
  provenance: z.object({
    source: z.enum(contextSources),
    sourceId: nonEmptyString.optional(),
  }),
});

export const AssumptionSchema = z.object({
  id: nonEmptyString,
  text: nonEmptyString,
  relatedField: nonEmptyString.optional(),
  confirmed: z.boolean().default(false),
  source: z.enum(["agent", "parent-item", "existing-item"]).optional(),
});

export const OpenQuestionSchema = z.object({
  id: nonEmptyString,
  text: nonEmptyString,
  status: z.enum(["open", "answered"]).default("open"),
  importance: z.enum(["important", "non-blocking"]).default("important"),
  relatedField: nonEmptyString.optional(),
  answer: z.string().optional(),
});

export const assessmentLevels = ["clear", "unclear", "missing", "not-applicable"] as const;
export const qualityAreas = [
  "problem",
  "objective",
  "outcome",
  "beneficiary",
  "value",
  "scope",
  "acceptance-criteria",
  "dependencies",
  "contradictions",
  "assumptions",
  "implementation-detail",
  "testability",
  "solution-independence",
  "abstraction",
  "lean-scope",
  "vertical-slicing",
] as const;

export const QualityAssessmentSchema = z.object({
  areas: z.array(z.object({
    area: z.enum(qualityAreas),
    level: z.enum(assessmentLevels),
    note: z.string().optional(),
  })).default([]),
  overall: z.enum(["needs-clarification", "ready", "ready-with-open-questions"]),
  excessiveTechnicalDetail: z.boolean().optional(),
  speculativeScope: z.boolean().optional(),
  unnecessaryConfigurability: z.boolean().optional(),
  mixedOutcomes: z.boolean().optional(),
  suggestedItemType: z.enum(backlogItemTypes).optional(),
  suggestedSplit: z.array(z.string()).optional(),
  excludedFollowUpCandidates: z.array(z.string()).optional(),
});

export const BacklogItemSchema = z.object({
  id: nonEmptyString,
  type: z.enum(backlogItemTypes),
  title: nonEmptyString,
  description: z.string().default(""),
  status: z.enum(backlogItemStatuses).default("draft"),
  contextValues: z.array(ContextValueSchema).default([]),
  assumptions: z.array(AssumptionSchema).default([]),
  openQuestions: z.array(OpenQuestionSchema).default([]),
  createdAt: z.string().datetime(),
  quality: QualityAssessmentSchema.optional(),
  updatedAt: z.string().datetime(),
});

export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;
export type BacklogItemType = (typeof backlogItemTypes)[number];
export type BacklogItemStatus = (typeof backlogItemStatuses)[number];
export type ContextValue = z.infer<typeof ContextValueSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;
export type BacklogItem = z.infer<typeof BacklogItemSchema>;
