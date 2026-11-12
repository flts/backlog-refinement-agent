/**
 * Builds an OpenAI-compatible API URL from an absolute URL or root-relative path such as /api.
 * `/v1/<path>` is appended; a legacy value ending in /v1 or /v1/chat/completions is tolerated.
 */
function parseEndpointBase(base: string): URL {
  const value = base.trim();
  if (value.startsWith('/') && !value.startsWith('//')) {
    return new URL(value, window.location.origin);
  }
  if (!/^https?:\/\//i.test(value)) {
    throw new TypeError('Endpoint must be an HTTP(S) URL or a root-relative path.');
  }
  return new URL(value);
}

export function isValidLlmEndpoint(base: string): boolean {
  try {
    const url = parseEndpointBase(base);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function llmApiUrl(base: string, path: 'chat/completions' | 'models'): URL {
  const url = parseEndpointBase(base);
  url.search = '';
  url.hash = '';
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
  url.pathname = `${prefix}/v1/${path}`;
  return url;
}
