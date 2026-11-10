import { describe, expect, it, vi } from 'vitest';
import { fetchAvailableModels, modelsUrl } from './availableModels';

describe('available models', () => {
  it('derives the models URL from the base URL', () => {
    expect(modelsUrl('https://proxy').href).toBe('https://proxy/v1/models');
    expect(modelsUrl('https://proxy/prefix/').href).toBe('https://proxy/prefix/v1/models');
    expect(modelsUrl('https://proxy/v1/chat/completions/?x=1').href).toBe('https://proxy/v1/models');
    expect(modelsUrl('https://proxy/v1').href).toBe('https://proxy/v1/models');
  });

  it('returns sorted unique model ids and sends the API key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, {}] }));
    expect(await fetchAvailableModels('https://proxy', 'key', fetcher)).toEqual(['a', 'b']);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer key' });
  });

  it('returns an empty list on failures or unexpected bodies', async () => {
    expect(await fetchAvailableModels('https://p', '', async () => new Response('', { status: 404 }))).toEqual([]);
    expect(await fetchAvailableModels('https://p', '', async () => Response.json({ nope: 1 }))).toEqual([]);
    expect(await fetchAvailableModels('https://p', '', async () => { throw new Error('cors'); })).toEqual([]);
    expect(await fetchAvailableModels('not a url', '')).toEqual([]);
  });
});
