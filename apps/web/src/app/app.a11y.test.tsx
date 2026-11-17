import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentClient } from '../agent';
import { fakeFetch, fakeTokens, sseResponse } from '../agent/testing';
import approvalHydrate from '../agent/__fixtures__/approval.hydrate.json';
import askHydrate from '../agent/__fixtures__/ask-user.hydrate.json';
import { createFakeAgentBackend, makeThread } from '../test/fakeAgentBackend';
import { createFakeBacklogApi, makeItem, makeMember, makeProject, makeSource } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi } from '../test/render';
import { Projects } from './Projects';

type Scenario = 'plain' | 'ask' | 'review';
const fixtures: Record<Scenario, unknown[] | undefined> = { plain: undefined, ask: askHydrate as unknown[], review: approvalHydrate as unknown[] };
const idle = [{ type: 'RUN_STARTED', threadId: 'thr-1', runId: 'h' }, { type: 'MESSAGES_SNAPSHOT', messages: [] }, { type: 'RUN_FINISHED', threadId: 'thr-1', runId: 'h' }];

function renderApp(scenario: Scenario) {
  const http = fakeFetch(() => sseResponse(fixtures[scenario] ?? idle));
  const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
  const agent = createFakeAgentBackend({ client, threads: [makeThread({ id: 'thr-1', itemId: 'i1', title: 'Refine export' })] });
  const api = createFakeBacklogApi({
    projects: [makeProject(), makeProject({ id: 'p2', name: 'Beta' })],
    items: [makeItem({ id: 'i1', title: 'Export', type: 'feature' }), makeItem({ id: 'i2', title: 'CSV', parentId: 'i1', type: 'user-story', status: 'ready' })],
    sources: [makeSource()],
    members: [makeMember(), makeMember({ email: 'bob@example.test', role: 'contributor', name: 'Bob' })],
  });
  api.state.presence = [{ email: 'bob@example.test', name: 'Bob Editor', itemId: 'i1', state: 'editing' }];
  return renderWithApi(<Projects />, api, undefined, agent.backend);
}

afterEach(() => { delete document.documentElement.dataset.theme; });

describe.each(['light', 'dark'] as const)('full app, %s theme', (theme) => {
  it.each<[Scenario, string]>([
    ['plain', 'refinement workspace with an item selected'],
    ['ask', 'an ask_user card pending'],
    ['review', 'a review pending'],
  ])('%s: %s has no axe violations and exactly one h1, banner and main', async (scenario) => {
    document.documentElement.dataset.theme = theme;
    const { container } = renderApp(scenario);
    await screen.findByRole('region', { name: 'Refinement workspace' });
    if (scenario === 'ask') await screen.findByRole('region', { name: 'The agent asks' }, { timeout: 5000 });
    if (scenario === 'review') await waitFor(() => expect(screen.getAllByRole('region').some((node) => node.className.includes('review-card'))).toBe(true), { timeout: 5000 });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // <header> inside a card <section> is not a banner landmark (Testing Library's role map does not model that), so count top-level ones.
    expect(container.querySelectorAll('.app-shell > header')).toHaveLength(1);
    expect(container.querySelectorAll('header:not(section header):not(article header)')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    await expectNoAxeViolations(container);
  }, 30_000);
});
