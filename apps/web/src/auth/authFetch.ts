import type { TokenProvider } from './types';

/** `fetch` that adds the bearer token (when there is one) and reports 401 responses to the provider. */
export function createAuthFetch(provider: TokenProvider, baseFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const token = await provider.getAccessToken();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await baseFetch(input, { ...init, headers });
    if (response.status === 401) provider.onUnauthorized();
    return response;
  };
}
