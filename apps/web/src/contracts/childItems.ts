import { z } from 'zod';
import { ItemTypeSchema, nonEmpty, RelationshipTypeSchema, uniqueBy } from './primitives';

export const PROPOSE_CHILD_ITEMS_TOOL_NAME = 'propose_child_items';

export const ProposedChildSchema = z.strictObject({
  proposalId: nonEmpty,
  title: nonEmpty,
  /** The child's full Markdown document; conformed to the child type's template server-side. */
  markdown: z.string(),
});

export const ProposedRelationshipSchema = z.strictObject({
  /** proposalId of a proposed child, or the parent item id. */
  sourceRef: nonEmpty,
  targetRef: nonEmpty,
  type: RelationshipTypeSchema,
});

export const ProposeChildItemsArgsSchema = z.strictObject({
  rationale: nonEmpty,
  childType: ItemTypeSchema,
  children: z.array(ProposedChildSchema).min(1).max(20),
  relationships: z.array(ProposedRelationshipSchema).max(40).optional(),
}).superRefine((args, ctx) => uniqueBy(args.children, (c) => c.proposalId, ctx, 'children', 'Child proposal ids must be unique.'));

export const ChildItemsResultSchema = z.strictObject({
  created: z.array(z.strictObject({ proposalId: nonEmpty, itemId: nonEmpty, title: z.string() })),
  edited: z.array(z.string()),
  rejected: z.array(z.string()),
  failed: z.array(z.strictObject({ proposalId: nonEmpty, reason: z.string() })),
  relationshipsCreated: z.number().int().min(0),
  relationshipsSkipped: z.array(z.strictObject({ sourceRef: z.string(), targetRef: z.string(), reason: z.string() })).optional(),
});

/** Predictive preview in the shared state: the (possibly incomplete) arguments of propose_child_items. */
export const ChildPreviewSchema = z.strictObject({
  rationale: z.string().optional(),
  childType: ItemTypeSchema.optional(),
  children: z.array(ProposedChildSchema),
  relationships: z.array(ProposedRelationshipSchema).optional(),
});

export type ProposedChild = z.infer<typeof ProposedChildSchema>;
export type ProposedRelationship = z.infer<typeof ProposedRelationshipSchema>;
export type ProposeChildItemsArgs = z.infer<typeof ProposeChildItemsArgsSchema>;
export type ChildItemsResult = z.infer<typeof ChildItemsResultSchema>;
export type ChildPreview = z.infer<typeof ChildPreviewSchema>;
