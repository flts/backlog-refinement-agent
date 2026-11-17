import { z } from 'zod';
import { ItemTypeSchema } from './primitives';

export const RECORD_QUALITY_ASSESSMENT_TOOL_NAME = 'record_quality_assessment';

export const assessmentLevels = ['clear', 'unclear', 'missing', 'not-applicable'] as const;
export const qualityAreas = [
  'problem', 'objective', 'outcome', 'beneficiary', 'value', 'scope', 'acceptance-criteria', 'dependencies',
  'contradictions', 'assumptions', 'implementation-detail', 'testability', 'solution-independence',
  'abstraction', 'lean-scope', 'vertical-slicing',
] as const;

const qualityShape = {
  overall: z.enum(['needs-clarification', 'ready', 'ready-with-open-questions']),
  areas: z.array(z.strictObject({
    area: z.enum(qualityAreas),
    level: z.enum(assessmentLevels),
    note: z.string().optional(),
  })).max(32),
  excessiveTechnicalDetail: z.boolean().optional(),
  speculativeScope: z.boolean().optional(),
  unnecessaryConfigurability: z.boolean().optional(),
  mixedOutcomes: z.boolean().optional(),
  suggestedItemType: ItemTypeSchema.optional(),
  suggestedSplit: z.array(z.string()).optional(),
  excludedFollowUpCandidates: z.array(z.string()).optional(),
};

export const QualityAssessmentArgsSchema = z.strictObject({
  ...qualityShape,
  summary: z.string().optional(),
  documentHash: z.string().optional(),
});

/** Latest assessment as mirrored into the shared state. */
export const StateQualitySchema = z.strictObject({
  ...qualityShape,
  summary: z.string().optional(),
  documentHash: z.string().optional(),
  assessedAt: z.string().optional(),
  stale: z.boolean().optional(),
});

export type QualityAssessmentArgs = z.infer<typeof QualityAssessmentArgsSchema>;
export type StateQuality = z.infer<typeof StateQualitySchema>;
