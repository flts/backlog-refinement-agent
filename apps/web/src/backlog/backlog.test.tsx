import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ItemSummary } from '../api';
import { SidebarPanel } from '../app/SidebarPanel';
import { TestAgentClientProvider, type AgentBackend, agentKeys } from '../run';
import { expectNoAxeViolations } from '../test/axe';
import { createFakeAgentBackend, makeThread } from '../test/fakeAgentBackend';
import { testQueryClient } from '../test/render';
import { filterStorageKey } from './useBacklogFilter';
import { statusByItem, useProjectThreadStatuses } from './useProjectThreadStatuses';
import { ThreadStatusBadge } from './ThreadStatusBadge';

const item = (id: string, title: string, over: Partial<ItemSummary> = {}): ItemSummary => ({ id, parentId: null, type: 'feature', title, status: 'draft', version: 1, quality: null, updatedAt: '', updatedBy: '', ...over });
const items = [item('cap', 'Checkout', { type: 'capability' }), item('feat', 'Payments', { parentId: 'cap' }), item('story', 'Pay with iDEAL', { parentId: 'feat', type: 'user-story', status: 'ready' }), item('rep', 'Reporting', { type: 'capability' })];

function Sidebar({ statuses }: { statuses?: Map<string, 'awaiting_input' | 'awaiting_review' | 'running' | 'idle'> }) {
  const [selected, setSelected] = useState<string>();
  return <SidebarPanel className="sidebar" items={items} projectId="p1" selectedId={selected} onSelect={setSelected} onCreate={() => undefined} threadStatuses={statuses} />;
}

beforeEach(() => sessionStorage.clear());

describe('backlog filter in the sidebar', () => {
  it('filters by title, keeps ancestors dimmed and announces the count', async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.type(screen.getByRole('searchbox', { name: 'Filter backlog items by title' }), 'ideal');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4 items match');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Pay with iDEAL')).toBeInTheDocument();
    expect(screen.getByText('Checkout').closest('.tree-row')).toHaveClass('tree-row-context');
    expect(screen.getByText('Pay with iDEAL').closest('.tree-row')).not.toHaveClass('tree-row-context');
    expect(screen.queryByText('Reporting')).not.toBeInTheDocument();
  });

  it('filters with type, status and needs-input chips', async () => {
    const user = userEvent.setup();
    render(<Sidebar statuses={new Map([['rep', 'awaiting_input'], ['feat', 'running']])} />);
    await user.click(screen.getByRole('button', { name: /Needs input/ }));
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4 item');
    expect(screen.queryByText('Payments')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters', hidden: false }));
    await user.click(screen.getByRole('button', { name: 'User story' }));
    expect(screen.getByRole('button', { name: 'User story' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4 items match');
    await user.click(screen.getByRole('button', { name: 'Draft' }));
    expect(screen.getByText('No items match')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[1]);
    expect(screen.getByText('Reporting')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('focuses the search with "/" unless typing in a field, and Esc clears', async () => {
    const user = userEvent.setup();
    render(<><input aria-label="Other field" /><Sidebar /></>);
    const search = screen.getByRole('searchbox', { name: 'Filter backlog items by title' });
    await user.keyboard('/');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('');
    await user.type(search, 'rep');
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await user.click(screen.getByRole('textbox', { name: 'Other field' }));
    await user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Other field' })).toHaveValue('/');
  });

  it('remembers the filter per project in sessionStorage', async () => {
    const user = userEvent.setup();
    const first = render(<Sidebar />);
    await user.type(screen.getByRole('searchbox', { name: 'Filter backlog items by title' }), 'rep');
    await user.click(screen.getByRole('button', { name: 'Capability' }));
    expect(JSON.parse(sessionStorage.getItem(filterStorageKey('p1'))!)).toMatchObject({ query: 'rep', types: ['capability'] });
    first.unmount();
    render(<Sidebar />);
    expect(screen.getByRole('searchbox', { name: 'Filter backlog items by title' })).toHaveValue('rep');
    expect(screen.getByRole('button', { name: 'Capability' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(sessionStorage.getItem(filterStorageKey('p1'))).toBeNull();
  });

  it('has no axe violations while filtering with badges', async () => {
    const user = userEvent.setup();
    const { container } = render(<Sidebar statuses={new Map([['rep', 'awaiting_review'], ['story', 'awaiting_input'], ['feat', 'running']])} />);
    await expectNoAxeViolations(container);
    await user.type(screen.getByRole('searchbox', { name: 'Filter backlog items by title' }), 'ideal');
    await expectNoAxeViolations(container);
    document.documentElement.dataset.theme = 'dark';
    await expectNoAxeViolations(container);
    delete document.documentElement.dataset.theme;
  });
});

describe('ThreadStatusBadge', () => {
  it('renders accessible text per status', () => {
    const { container, rerender } = render(<ThreadStatusBadge status="awaiting_input" />);
    expect(screen.getByText('Needs your input')).toBeInTheDocument();
    rerender(<ThreadStatusBadge status="awaiting_review" />);
    expect(screen.getByText('Review changes')).toBeInTheDocument();
    rerender(<ThreadStatusBadge status="running" />);
    expect(screen.getByText('Agent is working')).toHaveClass('sr-only');
    rerender(<ThreadStatusBadge status="idle" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useProjectThreadStatuses', () => {
  const threads = [
    makeThread({ id: 'a', itemId: 'i1', status: 'running' }), makeThread({ id: 'b', itemId: 'i1', status: 'awaiting_input' }),
    makeThread({ id: 'c', itemId: 'i2', status: 'awaiting_review' }), makeThread({ id: 'd', itemId: 'i2', status: 'awaiting_input' }),
    makeThread({ id: 'e', itemId: 'i3', status: 'idle' }), makeThread({ id: 'f', itemId: 'i4', status: 'running' }),
    makeThread({ id: 'g', itemId: 'x', projectId: 'other', status: 'awaiting_input' }),
  ];

  it('picks the highest-priority status per item', () => {
    expect([...statusByItem(threads.slice(0, 6))]).toEqual([['i1', 'awaiting_input'], ['i2', 'awaiting_review'], ['i3', 'idle'], ['i4', 'running']]);
  });

  function setup() {
    const fake = createFakeAgentBackend({ threads });
    const queryClient = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><TestAgentClientProvider backend={fake.backend as AgentBackend}>{children}</TestAgentClientProvider></QueryClientProvider>;
    return { ...fake, queryClient, hook: renderHook(() => useProjectThreadStatuses('p1'), { wrapper }) };
  }

  it('makes one project-wide query and exposes the items that need the user', async () => {
    const { hook, calls } = setup();
    await waitFor(() => expect(hook.result.current.statuses.size).toBe(4));
    expect([...hook.result.current.needsInput].sort()).toEqual(['i1', 'i2']);
    expect(calls).toEqual(['list']);
  });

  it('is refetched by invalidating the project threads key, which also covers the per-item key', async () => {
    const { hook, calls, threads: store, queryClient } = setup();
    await waitFor(() => expect(hook.result.current.statuses.size).toBe(4));
    expect(agentKeys.threads('p1', 'i1').slice(0, 3)).toEqual([...agentKeys.projectThreads('p1')]);
    store[store.findIndex((thread) => thread.id === 'f')] = makeThread({ id: 'f', itemId: 'i4', status: 'awaiting_input' });
    await act(() => queryClient.invalidateQueries({ queryKey: agentKeys.projectThreads('p1') }));
    await waitFor(() => expect(hook.result.current.needsInput.has('i4')).toBe(true));
    expect(calls).toEqual(['list', 'list']);
  });
});
