import { z } from 'zod';
import { nonEmpty, SuggestedStatusSchema, uniqueBy } from './primitives';

export const PROPOSE_DOCUMENT_CHANGES_TOOL_NAME = 'propose_document_changes';

export const SectionChangeSchema = z.strictObject({
  /** Unique within the proposal; used for accept/edit/reject and in the result. */
  id: nonEmpty,
  /** Level-2 heading without the leading `##`. */
  heading: nonEmpty.max(200),
  mode: z.enum(['replace', 'append']).default('replace'),
  markdown: z.string(),
  rationale: z.string().optional(),
});

export const ProposeDocumentChangesArgsSchema = z.strictObject({
  summary: nonEmpty,
  suggestedTitle: nonEmpty.optional(),
  suggestedStatus: SuggestedStatusSchema.optional(),
  baseVersion: z.number().int().min(0),
  sections: z.array(SectionChangeSchema).min(1).max(20),
}).superRefine((args, ctx) => uniqueBy(args.sections, (s) => s.id, ctx, 'sections', 'Section ids must be unique.'));

export const SectionConflictSchema = z.strictObject({
  sectionId: nonEmpty,
  heading: z.string(),
  reason: z.string(),
  currentMarkdown: z.string().optional(),
});

const documentChangesResultShape = {
  applied: z.array(z.string()),
  edited: z.array(z.string()),
  rejected: z.array(z.string()),
  conflicted: z.array(SectionConflictSchema),
  newVersion: z.number().int().min(0),
  warnings: z.array(z.string()).optional(),
  titleApplied: z.boolean().optional(),
  statusApplied: z.boolean().optional(),
};

export const DocumentChangesResultSchema = z.strictObject(documentChangesResultShape);

/** Predictive preview in the shared state: the (possibly incomplete) arguments of propose_document_changes. */
export const DocumentPreviewSchema = z.strictObject({
  summary: z.string().optional(),
  suggestedTitle: z.string().optional(),
  suggestedStatus: SuggestedStatusSchema.optional(),
  baseVersion: z.number().int().min(0).optional(),
  sections: z.array(SectionChangeSchema),
});

export type SectionChange = z.infer<typeof SectionChangeSchema>;
export type ProposeDocumentChangesArgs = z.infer<typeof ProposeDocumentChangesArgsSchema>;
export type SectionConflict = z.infer<typeof SectionConflictSchema>;
export type DocumentChangesResult = z.infer<typeof DocumentChangesResultSchema>;
export type DocumentPreview = z.infer<typeof DocumentPreviewSchema>;
