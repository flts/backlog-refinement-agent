import { normalizeRunErrorCode, type RunErrorCode } from '../contracts';

/** Stable keys for user-facing messages; fe-chat-ui can map them to its own (localised) copy. */
export const agentErrorKeys = [
  'unauthenticated',
  'forbidden',
  'notFound',
  'threadBusy',
  'rateLimited',
  'payloadTooLarge',
  'serviceUnavailable',
  'network',
  'streamInterrupted',
  'approvalExpired',
  'approvalRequired',
  'approvalInvalid',
  'runTimeout',
  'llmUnavailable',
  'backlogUnavailable',
  'toolValidationFailed',
  'invalidRequest',
  'internal',
] as const;
export type AgentErrorKey = (typeof agentErrorKeys)[number];

/** Heading and reason of the recovery card for a proposal the server can no longer resume (APPROVAL_RESUME_NOT_FOUND). */
export const proposalExpiredTitle = 'This proposal can no longer be applied';
export const proposalExpiredReason = 'The assistant no longer has it, for example after a service restart or because it was kept too long. Nothing was changed.';

export const agentErrorMessages: Record<AgentErrorKey, string> = {
  unauthenticated: 'Your session has expired. Please sign in again.',
  forbidden: 'You do not have access to this project or conversation.',
  notFound: 'This conversation or item no longer exists.',
  threadBusy: 'The assistant is still working on this conversation. Wait for it to finish or stop it first.',
  rateLimited: 'You are sending requests too quickly. Please wait a moment and try again.',
  payloadTooLarge: 'The request is too large. Shorten your message and try again.',
  serviceUnavailable: 'The assistant service is temporarily unavailable. Please try again shortly.',
  network: 'The connection to the assistant was lost. Check your network and try again.',
  streamInterrupted: 'The response was interrupted before it finished. Please try again.',
  approvalExpired: `${proposalExpiredTitle}. ${proposalExpiredReason}`,
  approvalRequired: 'There is a pending proposal that needs your decision before you can continue.',
  approvalInvalid: 'Your decision on the proposal could not be processed. Review it and try again.',
  runTimeout: 'The assistant took too long to respond. Please try again.',
  llmUnavailable: 'The language model is currently unavailable. Please try again later.',
  backlogUnavailable: 'The backlog service is currently unavailable. Please try again later.',
  toolValidationFailed: 'The assistant produced an invalid result several times. Please rephrase your request.',
  invalidRequest: 'The request was not accepted. Please try again.',
  internal: 'Something went wrong. Please try again; if it persists, share the run ID with support.',
};

export type AgentErrorSource = 'http' | 'run' | 'network' | 'stream' | 'local';

export interface AgentError {
  source: AgentErrorSource;
  code: RunErrorCode;
  key: AgentErrorKey;
  /** English user-facing text for `key`. */
  message: string;
  /** Sanitised server message (RUN_ERROR.message or problem `detail`), for "Copy details". */
  serverMessage?: string;
  status?: number;
  runId?: string;
  retryAfterSeconds?: number;
  /** Worth offering a Retry button. */
  retryable: boolean;
  /** APPROVAL_RESUME_NOT_FOUND: the proposal is gone (restart); the SPA shows the recovery card (keeps the user's edits, offers re-propose / start over). */
  proposalExpired: boolean;
  /** APPROVAL_RESUME_REQUIRED: a pending interrupt must be resumed first. */
  approvalRequired: boolean;
}

export class AgentApiError extends Error {
  constructor(readonly error: AgentError, options?: ErrorOptions) {
    super(error.serverMessage ?? error.message, options);
    this.name = 'AgentApiError';
  }
}

const keyByCode: Record<RunErrorCode, AgentErrorKey> = {
  APPROVAL_RESUME_REQUIRED: 'approvalRequired',
  APPROVAL_RESUME_NOT_FOUND: 'approvalExpired',
  APPROVAL_RESUME_INVALID: 'approvalInvalid',
  APPROVAL_RESUME_INVALID_RESPONSE: 'approvalInvalid',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'notFound',
  THREAD_BUSY: 'threadBusy',
  RATE_LIMITED: 'rateLimited',
  RUN_TIMEOUT: 'runTimeout',
  LLM_UNAVAILABLE: 'llmUnavailable',
  BACKLOG_UNAVAILABLE: 'backlogUnavailable',
  TOOL_VALIDATION_FAILED: 'toolValidationFailed',
  INVALID_REQUEST: 'invalidRequest',
  INTERNAL: 'internal',
};

const retryableKeys = new Set<AgentErrorKey>([
  'threadBusy',
  'rateLimited',
  'serviceUnavailable',
  'network',
  'streamInterrupted',
  'runTimeout',
  'llmUnavailable',
  'backlogUnavailable',
  'internal',
]);

interface ErrorInit {
  source: AgentErrorSource;
  code: RunErrorCode;
  key?: AgentErrorKey;
  serverMessage?: string;
  status?: number;
  runId?: string;
  retryAfterSeconds?: number;
}

function buildError(init: ErrorInit): AgentError {
  const key = init.key ?? keyByCode[init.code];
  return {
    source: init.source,
    code: init.code,
    key,
    message: agentErrorMessages[key],
    ...(init.serverMessage ? { serverMessage: init.serverMessage } : {}),
    ...(init.status !== undefined ? { status: init.status } : {}),
    ...(init.runId ? { runId: init.runId } : {}),
    ...(init.retryAfterSeconds !== undefined ? { retryAfterSeconds: init.retryAfterSeconds } : {}),
    retryable: retryableKeys.has(key),
    proposalExpired: init.code === 'APPROVAL_RESUME_NOT_FOUND',
    approvalRequired: init.code === 'APPROVAL_RESUME_REQUIRED',
  };
}

/** A RUN_ERROR event. Unknown codes (for example a raw exception class name) become INTERNAL. */
export function agentErrorFromRunError(event: { code?: unknown; message?: unknown; runId?: string }): AgentError {
  return buildError({
    source: 'run',
    code: normalizeRunErrorCode(event.code),
    serverMessage: typeof event.message === 'string' && event.message ? event.message : undefined,
    runId: event.runId,
  });
}

/** `Retry-After`: delay seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

function problemFields(payload: unknown): { slug?: string; detail?: string; retryAfter?: number } {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' && payload ? { detail: payload.slice(0, 300) } : {};
  const body = payload as Record<string, unknown>;
  const type = typeof body.type === 'string' ? body.type : undefined;
  const slug = type?.startsWith('/problems/') ? type.slice('/problems/'.length) : undefined;
  const detail = typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : undefined;
  const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : undefined;
  return { slug, detail, retryAfter };
}

export interface HttpErrorInput {
  status: number;
  /** Parsed problem+json (or text) body, when there was one. */
  payload?: unknown;
  /** Raw `Retry-After` header. */
  retryAfter?: string | null;
}

/** Maps an HTTP error response of agent-service (REST or the AG-UI endpoint, RFC 9457 problems). */
export function agentErrorFromHttp({ status, payload, retryAfter }: HttpErrorInput): AgentError {
  const problem = problemFields(payload);
  const retryAfterSeconds = parseRetryAfter(retryAfter) ?? problem.retryAfter;
  const base = { source: 'http' as const, status, serverMessage: problem.detail, retryAfterSeconds };
  switch (status) {
    case 401:
      return buildError({ ...base, code: 'UNAUTHENTICATED' });
    case 403:
      return buildError({ ...base, code: 'FORBIDDEN' });
    case 404:
      return buildError({ ...base, code: 'NOT_FOUND' });
    case 409:
      return buildError({ ...base, code: 'THREAD_BUSY' });
    case 413:
      return buildError({ ...base, code: 'INVALID_REQUEST', key: 'payloadTooLarge' });
    case 429:
      return buildError({ ...base, code: 'RATE_LIMITED' });
    case 400:
    case 422:
      return buildError({ ...base, code: 'INVALID_REQUEST' });
    default:
      break;
  }
  if (problem.slug === 'backlog-unavailable') return buildError({ ...base, code: 'BACKLOG_UNAVAILABLE' });
  if (problem.slug === 'llm-unavailable') return buildError({ ...base, code: 'LLM_UNAVAILABLE' });
  if (status === 502 || status === 503 || status === 504) return buildError({ ...base, code: 'INTERNAL', key: 'serviceUnavailable' });
  return buildError({ ...base, code: 'INTERNAL' });
}

export function agentErrorFromNetwork(cause: unknown): AgentError {
  return buildError({ source: 'network', code: 'INTERNAL', key: 'network', serverMessage: cause instanceof Error ? cause.message : undefined });
}

/** The stream ended without RUN_FINISHED or RUN_ERROR. */
export function agentErrorFromStreamEnd(): AgentError {
  return buildError({ source: 'stream', code: 'INTERNAL', key: 'streamInterrupted' });
}

/** Local one-run-per-thread guard (spike #18); the server is never contacted. */
export function agentErrorThreadBusyLocal(): AgentError {
  return buildError({ source: 'local', code: 'THREAD_BUSY' });
}

/** The `Error` thrown by @ag-ui/client's HTTP transport carries `status` and the parsed `payload`. */
export function agentErrorFromThrown(error: unknown, retryAfter?: string | null): AgentError {
  if (error instanceof AgentApiError) return error.error;
  if (error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number') {
    const { status, payload } = error as { status: number; payload?: unknown };
    return agentErrorFromHttp({ status, payload, retryAfter });
  }
  // fetch rejects with a TypeError when the network fails; anything else is a protocol or runtime failure.
  if (error instanceof TypeError) return agentErrorFromNetwork(error);
  return buildError({ source: 'stream', code: 'INTERNAL', serverMessage: error instanceof Error ? error.message : undefined });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
}
