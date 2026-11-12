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

const nonEmptyString = z.string().trim().min(1);

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

export const RevisionSchema = z.object({
  title: z.string(),
  description: z.string(),
  savedAt: z.string().datetime(),
});

export const maxRevisions = 10;

const BacklogItemBaseSchema = z.object({
  id: nonEmptyString,
  projectId: nonEmptyString,
  type: z.enum(backlogItemTypes),
  title: nonEmptyString,
  /** The item's Markdown document; its structure follows the item type's template. */
  description: z.string().default(""),
  status: z.enum(backlogItemStatuses).default("draft"),
  createdAt: z.string().datetime(),
  quality: QualityAssessmentSchema.optional(),
  revisions: z.array(RevisionSchema).default([]),
  updatedAt: z.string().datetime(),
});

export const backlogItemTypeSchema = BacklogItemBaseSchema.shape.type;
export const BacklogItemSchema = BacklogItemBaseSchema;

export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;
export type BacklogItemType = (typeof backlogItemTypes)[number];
export type BacklogItemStatus = (typeof backlogItemStatuses)[number];
export type Revision = z.infer<typeof RevisionSchema>;
export type BacklogItem = z.infer<typeof BacklogItemBaseSchema>;
