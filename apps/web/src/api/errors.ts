import type { components } from './backlog.schema';

export type ItemOut = components['schemas']['ItemOut'];

/** RFC 9457 problem document as sent by backlog-api (`application/problem+json`); extension members are allowed. */
export interface ProblemDocument {
  type?: string;
  title?: string;
  status?: number;
  detail?: string | null;
  instance?: string | null;
  [extension: string]: unknown;
}

export interface ApiErrorInit {
  status: number;
  type?: string;
  title?: string;
  detail?: string;
  extensions?: Record<string, unknown>;
  cause?: unknown;
}

/** Any non-2xx response (or `status` 0 when the network failed). */
export class ApiError extends Error {
  readonly status: number;
  /** Problem type URI, for example `/problems/version-conflict`; `about:blank` when the server sent none. */
  readonly type: string;
  readonly title: string;
  readonly detail?: string;
  /** Extension members of the problem document (everything except type, title, status, detail, instance). */
  readonly extensions: Record<string, unknown>;

  constructor({ status, type = 'about:blank', title, detail, extensions = {}, cause }: ApiErrorInit) {
    super(detail || title || `Request failed (HTTP ${status})`, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.title = title ?? this.message;
    this.detail = detail;
    this.extensions = extensions;
  }

  /** The problem slug (`version-conflict`, `owner-required`, …) or `undefined` for `about:blank`. */
  get slug(): string | undefined {
    const match = /\/problems\/([^/?#]+)$/.exec(this.type);
    return match?.[1];
  }
}

/** 409. A stale `If-Match` carries `currentVersion`, `changedSections` and the current `item` (see {@link isVersionConflict}). */
export class ConflictError extends ApiError {
  readonly currentVersion?: number;
  readonly changedSections: string[];
  readonly item?: ItemOut;

  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'ConflictError';
    const { currentVersion, changedSections, item } = init.extensions ?? {};
    this.currentVersion = typeof currentVersion === 'number' ? currentVersion : undefined;
    this.changedSections = Array.isArray(changedSections) ? changedSections.filter((entry): entry is string => typeof entry === 'string') : [];
    this.item = item && typeof item === 'object' ? (item as ItemOut) : undefined;
  }
}

/** 428: the write needs an `If-Match` header. */
export class PreconditionRequiredError extends ApiError {
  constructor(init: ApiErrorInit) {
    super(init);
    this.name = 'PreconditionRequiredError';
  }
}

/** True for the 409 that means "someone else changed this resource" (as opposed to e.g. a duplicate member). */
export function isVersionConflict(error: unknown): error is ConflictError {
  return error instanceof ConflictError && (error.slug === 'version-conflict' || error.currentVersion !== undefined);
}

const reserved = new Set(['type', 'title', 'status', 'detail', 'instance']);

function asProblem(body: unknown): ProblemDocument {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as ProblemDocument;
  if (typeof body === 'string' && body.trim()) return { detail: body.trim().slice(0, 300) };
  return {};
}

/** Maps a failed response (already parsed body, if any) onto the typed error classes. */
export function toApiError(status: number, body: unknown): ApiError {
  const problem = asProblem(body);
  const init: ApiErrorInit = {
    status,
    type: typeof problem.type === 'string' ? problem.type : undefined,
    title: typeof problem.title === 'string' ? problem.title : undefined,
    detail: typeof problem.detail === 'string' && problem.detail ? problem.detail : undefined,
    extensions: Object.fromEntries(Object.entries(problem).filter(([key]) => !reserved.has(key))),
  };
  if (status === 409) return new ConflictError(init);
  if (status === 428) return new PreconditionRequiredError(init);
  return new ApiError(init);
}

export function networkError(cause: unknown): ApiError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new ApiError({ status: 0, type: '/problems/network-error', title: 'Network error', detail: `The server could not be reached (${reason}).`, cause });
}

/** Reads and maps the body of a failed `Response` from plain `fetch` calls. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* keep the text */ }
  return toApiError(response.status, body);
}
