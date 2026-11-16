import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Projects } from '../app/Projects';
import { SidebarPanel } from '../app/SidebarPanel';
import { createFakeBacklogApi, makeItem, makeMember, makeProject } from '../test/fakeBacklogApi';
import { expectNoAxeViolations } from '../test/axe';
import { renderWithApi } from '../test/render';
import { attributionText } from './RevisionAttribution';

describe('collaboration wiring', () => {
  it('opens the Share dialog from the project toolbar', async () => {
    const user = userEvent.setup();
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()], members: [makeMember()] });
    renderWithApi(<Projects />, api);
    await user.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('dialog', { name: 'Alpha' })).toBeInTheDocument();
    expect(api.callsTo('GET', /members$/).length).toBeGreaterThan(0);
  });

  it('sends presence for the open item and shows others in the topbar, item header and tree', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()], members: [makeMember()] });
    api.state.presence = [{ email: 'anna@example.test', name: 'Anna Jansen', itemId: 'i1', state: 'editing' }];
    renderWithApi(<Projects />, api);
    await waitFor(() => expect(api.callsTo('POST', /presence$/).map((call) => call.body)).toContainEqual({ itemId: 'i1', state: 'viewing' }));
    expect(await screen.findByRole('list', { name: 'People in this project right now' })).toBeInTheDocument();
    expect(screen.getByText('Anna Jansen is editing')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Anna Jansen is editing' })).toBeInTheDocument();
  });

  it('shows a presence dot for items others have open', async () => {
    const { container } = render(<SidebarPanel className="sidebar" items={[{ id: 'i1', parentId: null, type: 'feature', title: 'Export', status: 'draft', version: 1, quality: null, updatedAt: '', updatedBy: '' }]}
      onSelect={() => undefined} onCreate={() => undefined} presenceFor={(id) => id === 'i1' ? [{ email: 'ben@example.test', name: 'Ben', itemId: 'i1', state: 'viewing' }] : []} />);
    expect(screen.getByRole('img', { name: 'Ben is viewing' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('attributes revisions to members and marks agent changes', () => {
    const revision = (id: string, actor: string, origin: 'manual' | 'agent' | 'restore', version: number) => ({ id, itemId: 'i1', version, title: 'T', origin, label: null, actor, runId: null, createdAt: '2026-01-01T10:00:00Z' });
    const names = (email: string) => email === 'anna@example.test' ? 'Anna' : email;
    expect(attributionText(revision('a', 'anna@example.test', 'agent', 3), names)).toBe('Anna via agent');
    expect(attributionText(revision('b', 'frank@example.test', 'manual', 2), names)).toBe('frank@example.test');
  });
});
