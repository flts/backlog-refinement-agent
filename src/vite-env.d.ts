/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LLM_ENDPOINT?: string;
  readonly VITE_LLM_MODEL?: string;
  readonly VITE_LLM_STREAMING?: string;
  readonly LOCAL_LLM_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
