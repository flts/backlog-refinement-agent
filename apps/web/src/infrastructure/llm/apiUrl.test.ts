import { describe, expect, it, vi } from 'vitest';
import { isValidLlmEndpoint, llmApiUrl } from './apiUrl';

describe('LLM API URLs', () => {
  it('resolves a root-relative prefix against the origin, not the current app path or query', () => {
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState({}, '', '/nested/app?view=chat#section');
    try {
      expect(llmApiUrl('/api/', 'chat/completions').href).toBe(`${window.location.origin}/api/v1/chat/completions`);
      expect(llmApiUrl('/api', 'models').href).toBe(`${window.location.origin}/api/v1/models`);
    } finally {
      window.history.replaceState({}, '', currentUrl);
    }
  });

  it('turns /api on host https://example into https://example/api/v1/models', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example' } });
    try {
      expect(llmApiUrl('/api', 'models').href).toBe('https://example/api/v1/models');
      expect(llmApiUrl('/api', 'chat/completions').href).toBe('https://example/api/v1/chat/completions');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('continues to accept absolute HTTP(S) URLs and rejects unsupported endpoint forms', () => {
    expect(isValidLlmEndpoint('https://proxy.example/api')).toBe(true);
    expect(isValidLlmEndpoint('/api')).toBe(true);
    expect(isValidLlmEndpoint('api')).toBe(false);
    expect(isValidLlmEndpoint('//proxy.example/api')).toBe(false);
    expect(isValidLlmEndpoint('ftp://proxy.example')).toBe(false);
    expect(isValidLlmEndpoint('')).toBe(false);
  });
});
