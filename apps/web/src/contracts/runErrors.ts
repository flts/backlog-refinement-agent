import { z } from 'zod';

/** Sanitized RUN_ERROR codes; see contracts/schemas/run-error-codes.schema.json. */
export const runErrorCodes = [
  'APPROVAL_RESUME_REQUIRED',
  'APPROVAL_RESUME_NOT_FOUND',
  'APPROVAL_RESUME_INVALID',
  'APPROVAL_RESUME_INVALID_RESPONSE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'THREAD_BUSY',
  'RATE_LIMITED',
  'RUN_TIMEOUT',
  'LLM_UNAVAILABLE',
  'BACKLOG_UNAVAILABLE',
  'TOOL_VALIDATION_FAILED',
  'INVALID_REQUEST',
  'INTERNAL',
] as const;

export const RunErrorCodeSchema = z.enum(runErrorCodes);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;

/** Unknown codes (for example a raw MAF exception class name) are treated as INTERNAL. */
export function normalizeRunErrorCode(code: unknown): RunErrorCode {
  const parsed = RunErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : 'INTERNAL';
}
