import { QueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { TestBacklogApiProvider } from '../api';
import type { FakeBacklogApi } from './fakeBacklogApi';
import { TestAgentClientProvider, type AgentBackend } from '../run';
import { TestAuth } from './auth';
import { createFakeAgentBackend } from './fakeAgentBackend';

export function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: Infinity }, mutations: { retry: false } } });
}

/** Renders with a fake backlog-api, a fresh query cache and a signed-in test user. */
export function renderWithApi(ui: ReactElement, api: FakeBacklogApi, queryClient = testQueryClient(), agent: AgentBackend = createFakeAgentBackend().backend) {
  return { queryClient, ...render(<TestAuth><TestBacklogApiProvider client={api.client} queryClient={queryClient}><TestAgentClientProvider backend={agent}>{ui}</TestAgentClientProvider></TestBacklogApiProvider></TestAuth>) };
}
