import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ErrorScreen, LoadingScreen } from '../app/StatusScreen';
import { loadRuntimeConfig, type RuntimeConfig } from './runtimeConfig';

const RuntimeConfigContext = createContext<RuntimeConfig | undefined>(undefined);

export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error('useRuntimeConfig must be used inside RuntimeConfigProvider.');
  return config;
}

/** Blocks the app until /config.json is loaded and valid. */
export function RuntimeConfigProvider({ load = loadRuntimeConfig, children }: { load?: () => Promise<RuntimeConfig>; children: ReactNode }) {
  const [state, setState] = useState<{ config?: RuntimeConfig; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setState({}); setAttempt((value) => value + 1); }, []);

  useEffect(() => {
    let active = true;
    load().then(
      (config) => { if (active) setState({ config }); },
      (cause: unknown) => { if (active) setState({ error: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { active = false; };
  }, [load, attempt]);

  if (state.error) return <ErrorScreen title="The app is not configured correctly" message={state.error} onAction={retry} />;
  if (!state.config) return <LoadingScreen message="Loading configuration…" />;
  return <RuntimeConfigContext.Provider value={state.config}>{children}</RuntimeConfigContext.Provider>;
}
