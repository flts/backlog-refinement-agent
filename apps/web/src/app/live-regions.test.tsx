import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresenceAnnouncer, RemoteChangeNotice, presenceChangeText, type PresenceUser } from '../collab';
import { ChatPanel, ThreadPicker, type ChatPanelProps } from '../chat';
import { AskUserArgsSchema } from '../contracts';
import { initialRunState, type RunState } from '../run';
import { AgentStatusPill } from '../shell/AgentStatusPill';
import { makeItem } from '../test/fakeBacklogApi';
import { makeThread } from '../test/fakeAgentBackend';
import { SaveStatus } from './SaveStatus';

afterEach(() => { vi.useRealTimers(); });

const anna: PresenceUser = { email: 'anna@example.test', name: 'Anna', itemId: 'i1', state: 'viewing' };
const ben: PresenceUser = { email: 'ben@example.test', name: 'Ben', itemId: null, state: 'viewing' };

describe('presence announcements', () => {
  it('words joins and leaves', () => {
    expect(presenceChangeText(['Anna'], [])).toBe('Anna joined');
    expect(presenceChangeText(['Anna', 'Ben'], ['Cy'])).toBe('Anna and Ben joined; Cy left');
    expect(presenceChangeText([], ['A', 'B', 'C', 'D'])).toBe('A, B and 2 others left');
  });

  it('stays quiet for people already there, then announces joiners and leavers once, batched', () => {
    vi.useFakeTimers();
    const { rerender } = render(<PresenceAnnouncer people={[anna]} delayMs={1000} />);
    const region = screen.getByTestId('presence-announcer');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();
    rerender(<PresenceAnnouncer people={[anna, ben]} delayMs={1000} />);
    expect(region).toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(region).toHaveTextContent('Ben joined');
    rerender(<PresenceAnnouncer people={[ben]} delayMs={1000} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(region).toHaveTextContent('Anna left');
    act(() => { vi.advanceTimersByTime(8000); });
    expect(region).toBeEmptyDOMElement();
  });

  it('ignores a heartbeat flicker (left and back within the throttle window)', () => {
    vi.useFakeTimers();
    const { rerender } = render(<PresenceAnnouncer people={[anna]} delayMs={1000} />);
    rerender(<PresenceAnnouncer people={[]} delayMs={1000} />);
    rerender(<PresenceAnnouncer people={[anna]} delayMs={1000} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByTestId('presence-announcer')).toBeEmptyDOMElement();
  });
});

describe('live region policy', () => {
  it('the agent pill is visual only (the chat announcer reads phase changes)', () => {
    const { container } = render(<AgentStatusPill phase="running" />);
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('the save status is silent while saving and saved, assertive only when a save fails', () => {
    const { container, rerender } = render(<SaveStatus status="saving" onResolve={vi.fn()} />);
    const live = () => container.querySelector('[aria-live]')!;
    expect(live()).toHaveAttribute('aria-live', 'assertive');
    expect(live()).toBeEmptyDOMElement();
    rerender(<SaveStatus status="saved" onResolve={vi.fn()} />);
    expect(live()).toBeEmptyDOMElement();
    rerender(<SaveStatus status="conflict" onResolve={vi.fn()} />);
    expect(live()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Conflict – resolve' })).toBeInTheDocument();
    rerender(<SaveStatus status="error" onResolve={vi.fn()} />);
    expect(live()).toHaveTextContent('could not be saved');
  });

  it('a remote item update is announced politely once and clears itself', () => {
    vi.useFakeTimers();
    const change = { key: 1, itemId: 'i1', actor: 'anna@example.test', title: 'Export' } as unknown as Parameters<typeof RemoteChangeNotice>[0]['change'];
    const { rerender } = render(<RemoteChangeNotice change={undefined} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    rerender(<RemoteChangeNotice change={change} />);
    expect(screen.getByRole('status')).not.toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  const props = (run: RunState, overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
    className: 'chat', item: makeItem(), threads: [], run, busy: false, canRetry: false, message: '',
    onSelectItem: vi.fn(), onNewThread: vi.fn(), onSelectThread: vi.fn(), onRenameThread: vi.fn(), onDeleteThread: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
    onStop: vi.fn(), onRetry: vi.fn(), onAnswer: vi.fn(), onDecideAll: vi.fn(), onCreateItem: vi.fn(), ...overrides,
  });
  const ask = AskUserArgsSchema.parse({ questions: [{ id: 'q1', header: 'Scope', question: 'Which users?', options: [{ label: 'Admins' }, { label: 'All' }] }] });
  const asking: RunState = { ...initialRunState('t'), phase: 'awaitingInput', pendingAskUser: { toolCallId: 'c1', args: ask } as RunState['pendingAskUser'] };

  it('announces an ask_user card exactly once (the card, not the chat announcer)', () => {
    render(<ChatPanel {...props(asking)} />);
    const texts = screen.getAllByRole('status').map((node) => node.textContent);
    expect(texts.filter((text) => text === 'The agent has 1 question')).toHaveLength(1);
    expect(texts.some((text) => /needs your input/.test(text ?? ''))).toBe(false);
  });

  it('hands focus to the composer when the answered card unmounts', () => {
    const { rerender } = render(<ChatPanel {...props(asking)} />);
    expect(screen.getByRole('region', { name: 'The agent asks' })).toHaveFocus();
    rerender(<ChatPanel {...props({ ...initialRunState('t'), phase: 'running' }, { busy: true })} />);
    // While the agent works the composer is read-only (focusable); after it finishes it is editable again.
    expect(screen.getByLabelText('Message the refinement agent')).toHaveFocus();
  });

  it('does not steal focus when the user already moved it elsewhere', () => {
    const { rerender } = render(<><button>elsewhere</button><ChatPanel {...props(asking)} /></>);
    screen.getByRole('button', { name: 'elsewhere' }).focus();
    rerender(<><button>elsewhere</button><ChatPanel {...props({ ...initialRunState('t'), phase: 'running' }, { busy: true })} /></>);
    expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus();
  });
});

describe('ThreadPicker focus', () => {
  it('Escape closes the list and returns focus to the trigger; no trap', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [active] = useState('a');
      return <><ThreadPicker threads={[makeThread({ id: 'a', title: 'Scope' })]} activeThreadId={active} onSelect={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} /><button>after</button></>;
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /^Sessions/ });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'New session' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });
});
