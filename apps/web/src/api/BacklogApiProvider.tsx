import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createAuthFetch, useAuth } from '../auth';
import { useRuntimeConfig } from '../config/RuntimeConfigProvider';
import { createBacklogClient, type BacklogClient } from './client';
import { ApiError } from './errors';

const BacklogClientContext = createContext<BacklogClient | undefined>(undefined);

export function useBacklogClient(): BacklogClient {
  const client = useContext(BacklogClientContext);
  if (!client) throw new Error('useBacklogClient must be used inside BacklogApiProvider.');
  return client;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // 4xx answers will not change by repeating the request.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

/** Creates the REST client from runtime config + auth, and the TanStack Query cache the hooks in `./queries` use. */
export function BacklogApiProvider({ children, client, queryClient }: { children: ReactNode; client?: BacklogClient; queryClient?: QueryClient }) {
  const config = useRuntimeConfig();
  const { provider } = useAuth();
  const api = useMemo(() => client ?? createBacklogClient({ baseUrl: config.api.backlog, fetch: createAuthFetch(provider) }), [client, config.api.backlog, provider]);
  const cache = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  return <BacklogClientContext.Provider value={api}><QueryClientProvider client={cache}>{children}</QueryClientProvider></BacklogClientContext.Provider>;
}

/** For tests and stories: provides a ready-made client without runtime config or auth. */
export function TestBacklogApiProvider({ client, queryClient = createQueryClient(), children }: { client: BacklogClient; queryClient?: QueryClient; children: ReactNode }) {
  return <BacklogClientContext.Provider value={client}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></BacklogClientContext.Provider>;
}
