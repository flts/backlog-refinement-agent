import { z } from 'zod';
import { ChildPreviewSchema } from './childItems';
import { DocumentChangesResultSchema, DocumentPreviewSchema } from './documentChanges';
import { NextActionSchema } from './nextActions';
import { AgentIntentSchema, ItemTypeSchema, nonEmpty } from './primitives';
import { StateQualitySchema } from './quality';

export const AGENT_STATE_SCHEMA_VERSION = 1;

/**
 * Shared AG-UI state. `preview` is required and nullable: initialise it to `null`, otherwise the
 * JSON-Patch `replace /preview` of @ag-ui/client fails. Unknown keys are tolerated on purpose.
 */
export const AgentStateSchema = z.looseObject({
  schemaVersion: z.literal(AGENT_STATE_SCHEMA_VERSION),
  projectId: nonEmpty,
  itemId: nonEmpty,
  itemType: ItemTypeSchema.optional(),
  preview: DocumentPreviewSchema.nullable(),
  childPreview: ChildPreviewSchema.nullable().optional(),
  nextActions: z.array(NextActionSchema).max(3).optional(),
  quality: StateQualitySchema.nullable().optional(),
  lastApply: DocumentChangesResultSchema.nullable().optional(),
});

/** Client-side initial state for a run; `preview` is null by contract. */
export function initialAgentState(projectId: string, itemId: string, itemType?: AgentState['itemType']): AgentState {
  return { schemaVersion: AGENT_STATE_SCHEMA_VERSION, projectId, itemId, ...(itemType ? { itemType } : {}), preview: null };
}

/** AG-UI forwardedProps are dropped by MAF above 512 serialized characters. */
export const FORWARDED_PROPS_MAX_LENGTH = 512;

export const ForwardedPropsSchema = z.strictObject({
  intent: AgentIntentSchema,
  childType: ItemTypeSchema.optional(),
}).refine((props) => JSON.stringify(props).length <= FORWARDED_PROPS_MAX_LENGTH, {
  message: `Serialized forwardedProps must not exceed ${FORWARDED_PROPS_MAX_LENGTH} characters.`,
});

export type AgentState = z.infer<typeof AgentStateSchema>;
export type ForwardedProps = z.infer<typeof ForwardedPropsSchema>;
