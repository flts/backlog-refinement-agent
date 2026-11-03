import { describe, expect, it } from 'vitest';
import { localDevelopmentKey } from './localDevelopmentKey';

describe('local development API key', () => {
  it('exposes the key only to the local development server', () => {
    expect(localDevelopmentKey('serve', 'development', {
      LOCAL_LLM_API_KEY: 'local-only',
    })).toBe('local-only');
  });

  it('omits the key from production builds and non-development modes', () => {
    const environment = { LOCAL_LLM_API_KEY: 'must-not-ship' };

    expect(localDevelopmentKey('build', 'production', environment)).toBe('');
    expect(localDevelopmentKey('serve', 'production', environment)).toBe('');
    expect(localDevelopmentKey('build', 'development', environment)).toBe('');
  });
});
