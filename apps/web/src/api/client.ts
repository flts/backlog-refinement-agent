import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './backlog.schema';
import { ApiError, errorFromResponse, networkError, toApiError } from './errors';

export type BacklogHttp = Client<paths>;

export interface BacklogClientOptions {
  /** `api.backlog` from /config.json, for example `/api/backlog`. The generated paths are relative to it. */
  baseUrl: string;
  /** Pass `createAuthFetch(provider)`; defaults to the global `fetch` (no authentication). */
  fetch?: typeof fetch;
}

export interface BacklogClient {
  /** Typed openapi-fetch client. Prefer {@link unwrap} over reading `{ data, error }` yourself. */
  readonly http: BacklogHttp;
  readonly baseUrl: string;
  /** Authenticated `fetch` for endpoints that are not in the OpenAPI snapshot yet (path relative to `baseUrl`). */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export function createBacklogClient({ baseUrl, fetch: fetchImpl = (input, init) => globalThis.fetch(input, init) }: BacklogClientOptions): BacklogClient {
  const root = baseUrl.replace(/\/+$/, '');
  // `Request` objects (openapi-fetch) need an absolute URL outside the browser's own resolution, so anchor a relative base at the page origin.
  const origin = typeof location === 'undefined' ? undefined : location.origin;
  const absolute = root.startsWith('/') && origin && origin !== 'null' ? `${origin}${root}` : root;
  const http = createClient<paths>({ baseUrl: absolute, fetch: (request) => fetchImpl(request) });
  return {
    http,
    baseUrl: root,
    request: (path, init) => fetchImpl(`${root}${path.startsWith('/') ? path : `/${path}`}`, init).catch((cause: unknown) => { throw networkError(cause); }),
  };
}

type Result<D> = { data?: D; error?: unknown; response: Response };

/** Awaits an openapi-fetch call and returns its data; failures throw {@link ApiError} (or `ConflictError` / `PreconditionRequiredError`). */
export async function unwrap<D>(call: Promise<Result<D>>): Promise<D> {
  let result: Result<D>;
  try {
    result = await call;
  } catch (cause) {
    throw cause instanceof ApiError ? cause : networkError(cause);
  }
  if (!result.response.ok) throw toApiError(result.response.status, result.error);
  return result.data as D;
}

/** Like {@link BacklogClient.request} but throws the mapped error for non-2xx responses. */
export async function requestOk(client: BacklogClient, path: string, init?: RequestInit): Promise<Response> {
  const response = await client.request(path, init);
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

/** `If-Match` value for a known resource version (a quoted strong ETag, as the server sends it). */
export function ifMatch(version: number): string {
  return `"${version}"`;
}

/** The resource version from an `ETag` response header (`"7"`, `W/"7"` or `7`); `undefined` if absent or not a version. */
export function readEtag(response: Pick<Response, 'headers'>): number | undefined {
  const match = /^(?:W\/)?"?(\d{1,10})"?$/.exec(response.headers.get('ETag')?.trim() ?? '');
  return match ? Number(match[1]) : undefined;
}
