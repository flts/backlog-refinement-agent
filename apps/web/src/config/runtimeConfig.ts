import { z } from 'zod';

/**
 * Deployment settings are read at runtime from /config.json, never compiled into the bundle and never secret.
 * Production: served by Caddy from container environment variables. Development: served by the Vite dev server.
 */
const optionalText = z.string().trim().transform((value) => value || undefined).optional();

export const RuntimeConfigSchema = z.object({
  auth: z.object({
    mode: z.enum(['platform', 'oidc']),
    authority: optionalText,
    clientId: optionalText,
    scope: optionalText,
  }),
  api: z.object({
    backlog: z.string().trim().startsWith('/').or(z.url()),
    agent: z.string().trim().startsWith('/').or(z.url()),
  }),
  agentId: z.string().trim().min(1),
}).superRefine((config, context) => {
  if (config.auth.mode !== 'oidc') return;
  for (const field of ['authority', 'clientId'] as const) {
    if (!config.auth[field]) context.addIssue({ code: 'custom', path: ['auth', field], message: `auth.${field} is required when auth.mode is "oidc"` });
  }
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const defaultOidcScope = 'openid profile email';

export class RuntimeConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeConfigError';
  }
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const result = RuntimeConfigSchema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  throw new RuntimeConfigError(`/config.json is invalid: ${details}`);
}

export async function loadRuntimeConfig(
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  url = '/config.json',
): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetcher(url, { cache: 'no-store' });
  } catch (cause) {
    throw new RuntimeConfigError('/config.json could not be reached. Check your network connection and that the web server is running.', { cause });
  }
  if (!response.ok) throw new RuntimeConfigError(`/config.json could not be loaded (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RuntimeConfigError('/config.json is not valid JSON.', { cause });
  }
  return parseRuntimeConfig(body);
}
