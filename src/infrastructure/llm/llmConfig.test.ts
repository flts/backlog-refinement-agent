import { describe, expect, it } from 'vitest';
import { parseRuntimeLlmConfig, loadRuntimeLlmConfig, resolveLlmConnection, loadLlmOverrides, saveLlmOverrides, clearLlmOverrides } from './llmConfig';

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

  it('parses runtime config and drops the API key outside development', () => {
    const data = { endpoint: ' https://a ', model: 'm', apiKey: 'k', streaming: 'true' };
    expect(parseRuntimeLlmConfig(data, true)).toEqual({ endpoint: 'https://a', model: 'm', apiKey: 'k', streaming: true });
    expect(parseRuntimeLlmConfig(data, false).apiKey).toBe('');
    expect(parseRuntimeLlmConfig(null, true)).toEqual({ endpoint: '', model: '', apiKey: '', streaming: false });
  });

  it('falls back to empty runtime config when config.json is missing or invalid', async () => {
    const empty = { endpoint: '', model: '', apiKey: '', streaming: false };
    expect(await loadRuntimeLlmConfig(async () => new Response('', { status: 404 }), false)).toEqual(empty);
    expect(await loadRuntimeLlmConfig(async () => new Response('<html>'), false)).toEqual(empty);
    expect(await loadRuntimeLlmConfig(async () => Response.json({ model: 'x' }), false)).toEqual({ ...empty, model: 'x' });
  });

  it('loads runtime config from the origin root regardless of the app base path', async () => {
    let requestedUrl = '';
    await loadRuntimeLlmConfig(async (input) => {
      requestedUrl = String(input);
      return Response.json({});
    }, false);
    expect(requestedUrl).toBe('/config.json');
  });
});
