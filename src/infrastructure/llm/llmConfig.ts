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

export function getLlmEnvironment(): LlmOverrides {
  return {
    endpoint: import.meta.env.VITE_LLM_ENDPOINT?.trim() ?? '',
    model: import.meta.env.VITE_LLM_MODEL?.trim() ?? '',
    apiKey: import.meta.env.DEV ? import.meta.env.LOCAL_LLM_API_KEY?.trim() ?? '' : '',
  };
}

/** Values entered in the settings screen win over environment variables. */
export function resolveLlmConnection(overrides: LlmOverrides, environment: LlmOverrides = getLlmEnvironment()): LlmOverrides {
  return {
    endpoint: overrides.endpoint || environment.endpoint,
    model: overrides.model || environment.model,
    apiKey: overrides.apiKey || environment.apiKey,
  };
}

export function getLlmConfiguration(overrides: LlmOverrides = loadLlmOverrides()): LlmConfiguration {
  return {
    ...resolveLlmConnection(overrides),
    streaming: import.meta.env.VITE_LLM_STREAMING?.trim().toLowerCase() === 'true',
  };
}
