import { z } from 'zod';

/** Shared building blocks of the agent contracts. Mirrors `contracts/schemas/*.schema.json`. */
export const itemTypes = ['capability', 'feature', 'user-story', 'enabler'] as const;
export const ItemTypeSchema = z.enum(itemTypes);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const suggestedStatuses = ['ready', 'ready-with-open-questions'] as const;
export const SuggestedStatusSchema = z.enum(suggestedStatuses);

export const relationshipTypes = ['parent-child', 'supports', 'depends-on', 'related-to'] as const;
export const RelationshipTypeSchema = z.enum(relationshipTypes);

export const agentIntents = ['refine', 'continue', 'breakdown', 'assess'] as const;
export const AgentIntentSchema = z.enum(agentIntents);
export type AgentIntent = z.infer<typeof AgentIntentSchema>;

export const nonEmpty = z.string().min(1);

/** Adds an issue for every duplicate value of `key` in `items`. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string, ctx: z.RefinementCtx, path: string, message: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = key(item);
    if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [path, index], message });
    seen.add(value);
  });
}
