import { llmApiUrl } from './apiUrl';

export const modelsUrl = (base: string): URL => llmApiUrl(base, 'models');

/** Returns model ids from GET /v1/models, or an empty list when the endpoint does not provide them. */
export async function fetchAvailableModels(
  endpoint: string,
  apiKey: string,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const response = await fetcher(modelsUrl(endpoint), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (Array.isArray(body.data) ? body.data : []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
