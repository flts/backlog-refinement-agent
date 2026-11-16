import type { LlmConfiguration } from './ProxyLlmProvider';

export interface LlmOverrides {
  endpoint: string;
  model: string;
  apiKey: string;
}

export const emptyLlmOverrides: LlmOverrides = { endpoint: '', model: '', apiKey: '' };
export const llmOverridesStorageKey = 'llm-connection-overrides';

export function loadLlmOverrides(storage: Pick<Storage, 'getItem'> = localStorage): LlmOverrides {
  try {
    const parsed = JSON.parse(storage.getItem(llmOverridesStorageKey) ?? '{}') as Partial<LlmOverrides>;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return { endpoint: text(parsed.endpoint), model: text(parsed.model), apiKey: text(parsed.apiKey) };
  } catch {
    return emptyLlmOverrides;
  }
}

export function saveLlmOverrides(values: LlmOverrides, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): LlmOverrides {
  const clean = { endpoint: values.endpoint.trim(), model: values.model.trim(), apiKey: values.apiKey.trim() };
  if (!clean.endpoint && !clean.model && !clean.apiKey) storage.removeItem(llmOverridesStorageKey);
  else storage.setItem(llmOverridesStorageKey, JSON.stringify(clean));
  return clean;
}

export function clearLlmOverrides(storage: Pick<Storage, 'removeItem'> = localStorage): LlmOverrides {
  storage.removeItem(llmOverridesStorageKey);
  return emptyLlmOverrides;
}

export interface RuntimeLlmConfig extends LlmOverrides {
  streaming: boolean;
}

export const emptyRuntimeLlmConfig: RuntimeLlmConfig = { ...emptyLlmOverrides, streaming: false };

export function parseRuntimeLlmConfig(data: unknown, allowApiKey: boolean): RuntimeLlmConfig {
  const source = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return {
    endpoint: text(source.endpoint),
    model: text(source.model),
    apiKey: allowApiKey ? text(source.apiKey) : '',
    streaming: source.streaming === true || text(source.streaming).toLowerCase() === 'true',
  };
}

/**
 * Deployment settings are read at runtime from /config.json, never compiled into the bundle.
 * The API key is only honoured in development, where the Vite dev server serves it from .env.local.
 */
export async function loadRuntimeLlmConfig(
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  allowApiKey: boolean = import.meta.env.DEV,
  url = '/config.json',
): Promise<RuntimeLlmConfig> {
  try {
    const response = await fetcher(url, { cache: 'no-store' });
    if (!response.ok) return emptyRuntimeLlmConfig;
    return parseRuntimeLlmConfig(await response.json(), allowApiKey);
  } catch {
    return emptyRuntimeLlmConfig;
  }
}

/** Values entered in the settings screen win over runtime configuration. */
export function resolveLlmConnection(overrides: LlmOverrides, environment: LlmOverrides): LlmOverrides {
  return {
    endpoint: overrides.endpoint || environment.endpoint,
    model: overrides.model || environment.model,
    apiKey: overrides.apiKey || environment.apiKey,
  };
}

export function getLlmConfiguration(overrides: LlmOverrides, runtime: RuntimeLlmConfig): LlmConfiguration {
  return { ...resolveLlmConnection(overrides, runtime), streaming: runtime.streaming };
}
