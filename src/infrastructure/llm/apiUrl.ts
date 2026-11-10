/**
 * Builds an OpenAI-compatible API URL from a base URL (for example https://proxy.example).
 * `/v1/<path>` is appended; a legacy value ending in /v1 or /v1/chat/completions is tolerated.
 */
export function llmApiUrl(base: string, path: 'chat/completions' | 'models'): URL {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
  url.pathname = `${prefix}/v1/${path}`;
  return url;
}
