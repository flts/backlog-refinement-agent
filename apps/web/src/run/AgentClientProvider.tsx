import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createAgentClient, createThreadsApi, type AgentClient, type ThreadsApi } from '../agent';
import { useAuth } from '../auth';
import { useRuntimeConfig } from '../config/RuntimeConfigProvider';

export interface AgentBackend {
  client: AgentClient;
  threads: ThreadsApi;
}

const AgentBackendContext = createContext<AgentBackend | undefined>(undefined);

export function useAgentBackend(): AgentBackend {
  const backend = useContext(AgentBackendContext);
  if (!backend) throw new Error('useAgentBackend must be used inside AgentClientProvider.');
  return backend;
}

/** Creates the AG-UI client and the threads API from runtime config + auth. */
export function AgentClientProvider({ children, backend }: { children: ReactNode; backend?: AgentBackend }) {
  const config = useRuntimeConfig();
  const { provider } = useAuth();
  const value = useMemo<AgentBackend>(
    () => backend ?? {
      client: createAgentClient({ baseUrl: config.api.agent, agentId: config.agentId, tokenProvider: provider }),
      threads: createThreadsApi({ baseUrl: config.api.agent, tokenProvider: provider }),
    },
    [backend, config.api.agent, config.agentId, provider],
  );
  return <AgentBackendContext.Provider value={value}>{children}</AgentBackendContext.Provider>;
}

/** For tests and stories: provides a ready-made backend without runtime config or auth. */
export function TestAgentClientProvider({ backend, children }: { backend: AgentBackend; children: ReactNode }) {
  return <AgentBackendContext.Provider value={backend}>{children}</AgentBackendContext.Provider>;
}
