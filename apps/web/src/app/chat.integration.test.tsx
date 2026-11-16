import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createAgentClient } from '../agent';
import { fakeFetch, fakeTokens, sseResponse } from '../agent/testing';
import App from './App';
import { createFakeBacklogApi, makeItem, makeProject } from '../test/fakeBacklogApi';
import { createFakeAgentBackend, makeThread } from '../test/fakeAgentBackend';
import { renderWithApi } from '../test/render';
import { expectNoAxeViolations } from '../test/axe';
import approvalPropose from '../agent/__fixtures__/approval.propose.json';
import approvalResume from '../agent/__fixtures__/approval.resume.json';

function setup(responses: Parameters<typeof fakeFetch>[0]) {
  const http = fakeFetch((request, index) => {
    const body = request.body as { messages: unknown[]; resume?: unknown };
    // Hydration (no messages, no resume) of an empty thread.
    if (body.messages.length === 0 && !body.resume && index === 0) {
      return sseResponse([{ type: 'RUN_STARTED', threadId: 't1', runId: 'h' }, { type: 'MESSAGES_SNAPSHOT', messages: [] }, { type: 'RUN_FINISHED', threadId: 't1', runId: 'h' }]);
    }
    return typeof responses === 'function' ? responses(request, index) : responses.shift()!;
  });
  const client = createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch });
  const agent = createFakeAgentBackend({ client, threads: [makeThread({ id: 't1', itemId: 'i1' })] });
  const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()] });
  const view = renderWithApi(<App project={makeProject()} projectBusy={false} renderProjectPanel={() => null} />, api, undefined, agent.backend);
  return { ...view, http, agent };
}

const textRun = [
  { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
  { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Which users ' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'are in scope?' },
  { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
  { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
];

describe('chat with the agent', () => {
  it('sends a message, streams the answer and is accessible', async () => {
    const user = userEvent.setup();
    const { container, http } = setup([sseResponse(textRun)]);
    const box = await screen.findByLabelText('Message the refinement agent');
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, 'Please refine{Enter}');
    expect(await screen.findByText('Which users are in scope?')).toBeInTheDocument();
    expect(screen.getByText('Please refine')).toBeInTheDocument();
    const send = http.requests.find((request) => (request.body as { messages: unknown[] }).messages.length > 0)!;
    expect(send.body).toMatchObject({ threadId: 't1', state: { projectId: 'p1', itemId: 'i1' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull());
    await expectNoAxeViolations(container);
  });

  it('shows a stop button while the agent runs and stops it', async () => {
    const user = userEvent.setup();
    const pending = new Promise<Response>(() => undefined);
    const { http } = setup(() => pending as unknown as Response);
    const box = await screen.findByLabelText('Message the refinement agent');
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, 'slow{Enter}');
    const stop = await screen.findByRole('button', { name: /Stop/ });
    await waitFor(() => expect(http.requests.length).toBeGreaterThan(1));
    await user.click(stop);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull());
    expect(await screen.findByText('Stopped.')).toBeInTheDocument();
  });

  it('shows a proposal placeholder and approves it', async () => {
    const user = userEvent.setup();
    const { http } = setup([sseResponse(approvalPropose), sseResponse(approvalResume)]);
    const box = await screen.findByLabelText('Message the refinement agent');
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, 'improve{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Approve all' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve all' })).toBeNull());
    const resume = http.requests.at(-1)!.body as { resume: { status: string; payload: { approved: boolean } }[] };
    expect(resume.resume[0]).toMatchObject({ status: 'resolved', payload: { approved: true } });
  });
});
