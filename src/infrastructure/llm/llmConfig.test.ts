import { describe, expect, it } from 'vitest';
import { resolveLlmConnection, loadLlmOverrides, saveLlmOverrides, clearLlmOverrides } from './llmConfig';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('LLM connection overrides', () => {
  const env = { endpoint: 'https://env', model: 'env-model', apiKey: 'env-key' };

  it('prefers saved values and falls back to the environment per field', () => {
    expect(resolveLlmConnection({ endpoint: '', model: 'mine', apiKey: '' }, env)).toEqual({ endpoint: 'https://env', model: 'mine', apiKey: 'env-key' });
  });

  it('persists, reloads and clears overrides', () => {
    const storage = memoryStorage();
    saveLlmOverrides({ endpoint: ' https://x ', model: '', apiKey: 'secret' }, storage);
    expect(loadLlmOverrides(storage)).toEqual({ endpoint: 'https://x', model: '', apiKey: 'secret' });
    clearLlmOverrides(storage);
    expect(loadLlmOverrides(storage)).toEqual({ endpoint: '', model: '', apiKey: '' });
  });

  it('ignores corrupt stored data', () => {
    const storage = { getItem: () => '{nope' };
    expect(loadLlmOverrides(storage)).toEqual({ endpoint: '', model: '', apiKey: '' });
  });
});
