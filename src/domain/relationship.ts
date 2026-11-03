import { z } from "zod";

export const relationshipTypes = [
  "parent-child",
  "supports",
  "depends-on",
  "related-to",
] as const;

export const BacklogRelationshipSchema = z.object({
  sourceId: z.string().trim().min(1),
  targetId: z.string().trim().min(1),
  type: z.enum(relationshipTypes),
});

export type RelationshipType = (typeof relationshipTypes)[number];
export type BacklogRelationship = z.infer<typeof BacklogRelationshipSchema>;
