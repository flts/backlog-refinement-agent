import type { LlmConfiguration } from './ProxyLlmProvider';

export function getLlmConfiguration(): LlmConfiguration {
  return {
    endpoint: import.meta.env.VITE_LLM_ENDPOINT?.trim() ?? '',
    model: import.meta.env.VITE_LLM_MODEL?.trim() ?? '',
    streaming: import.meta.env.VITE_LLM_STREAMING?.trim().toLowerCase() === 'true',
    apiKey: import.meta.env.DEV ? import.meta.env.LOCAL_LLM_API_KEY?.trim() ?? '' : '',
  };
}
