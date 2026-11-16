import { z } from 'zod';
import { nonEmpty } from './primitives';

/**
 * Payload of one `RunAgentInput.resume[]` entry. `editedArgs` is a FULL replacement of the tool
 * arguments (never merged) and is validated against the tool's own args schema by the receiver.
 * `interruptId` is `interrupt.id` ("af-call-..."), not the toolCallId.
 */
export const ApprovalResumeSchema = z.strictObject({
  approved: z.boolean(),
  editedArgs: z.record(z.string(), z.unknown()).optional(),
});

export const ResumeEntrySchema = z.strictObject({
  interruptId: nonEmpty,
  status: z.enum(['resolved', 'cancelled']),
  payload: ApprovalResumeSchema.optional(),
}).superRefine((entry, ctx) => {
  if (entry.status === 'resolved' && !entry.payload) {
    ctx.addIssue({ code: 'custom', path: ['payload'], message: 'A resolved resume entry needs a payload.' });
  }
  if (entry.status === 'cancelled' && entry.payload) {
    ctx.addIssue({ code: 'custom', path: ['payload'], message: 'A cancelled resume entry must not carry a payload.' });
  }
});

export type ApprovalResume = z.infer<typeof ApprovalResumeSchema>;
export type ResumeEntry = z.infer<typeof ResumeEntrySchema>;
