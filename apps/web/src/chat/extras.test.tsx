import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '../agent';
import { initialRunState, type RunState, type TranscriptEntry } from '../run';
import { makeItem } from '../test/fakeBacklogApi';
import { makeThread } from '../test/fakeAgentBackend';
import { expectNoAxeViolations } from '../test/axe';
import { ChatPanel, MessageActions, MessageList, SessionTitle, SuggestionChips, type ChatPanelProps } from '.';

const assistant = (id: string, text: string): TranscriptEntry => ({ kind: 'assistant', id, text, streaming: false });
const runOf = (overrides: Partial<RunState> = {}): RunState => ({ ...initialRunState('t'), phase: 'idle', messages: [{ kind: 'user', id: 'u1', text: 'Hi' }, assistant('m1', 'Hello there')], ...overrides });
const withActions = (actions: RunState['agentState']['nextActions'], overrides: Partial<RunState> = {}) => runOf({ agentState: { ...initialRunState('t').agentState, nextActions: actions }, ...overrides });

const props = (run: RunState, overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
  className: 'chat', item: makeItem(), threads: [], run, busy: false, canRetry: false, message: '',
  onSelectItem: vi.fn(), onNewThread: vi.fn(), onSelectThread: vi.fn(), onRenameThread: vi.fn(), onDeleteThread: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
  onStop: vi.fn(), onRetry: vi.fn(), onAnswer: vi.fn(), onDecideAll: vi.fn(), onCreateItem: vi.fn(), onSuggestion: vi.fn(), ...overrides,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('SuggestionChips', () => {
  const actions = [
    { id: 'a', label: 'Break it down', intent: 'breakdown' as const },
    { id: 'b', label: 'Ask about scope', intent: 'message' as const, prompt: 'What is out of scope?' },
  ];

  it('renders a labelled group, drops invalid actions, caps at three and reports the choice', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const many = [...actions, { id: 'c', label: 'Three', intent: 'assess' }, { id: 'd', label: 'Four', intent: 'assess' }, { id: 'bad', label: 'No prompt', intent: 'message' }];
    render(<SuggestionChips actions={many} onSelect={onSelect} />);
    const group = screen.getByRole('group', { name: 'Suggested next steps' });
    expect(within(group).getAllByRole('button').map((button) => button.textContent?.replace('↳ ', ''))).toEqual(['Break it down', 'Ask about scope', 'Three']);
    await user.click(screen.getByRole('button', { name: /Ask about scope/ }));
    expect(onSelect).toHaveBeenCalledWith(actions[1]);
  });

  it('renders nothing without valid actions', () => {
    const { container } = render(<SuggestionChips actions={[{ nope: true }]} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows chips only once the run is idle and removes them when a new run starts', async () => {
    const onSuggestion = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ChatPanel {...props(withActions(actions), { onSuggestion })} />);
    await user.click(screen.getByRole('button', { name: /Break it down/ }));
    expect(onSuggestion).toHaveBeenCalledWith(actions[0]);
    rerender(<ChatPanel {...props(withActions([], { phase: 'running' }), { busy: true })} />);
    expect(screen.queryByRole('group', { name: 'Suggested next steps' })).toBeNull();
    rerender(<ChatPanel {...props(withActions(actions, { phase: 'awaitingReview' }))} />);
    expect(screen.queryByRole('group', { name: 'Suggested next steps' })).toBeNull();
  });

  it('is axe clean', async () => {
    const { container } = render(<ChatPanel {...props(withActions(actions))} />);
    await expectNoAxeViolations(container);
  });
});

describe('MessageActions', () => {
  it('toggles thumbs up, sends the rating once and withdraws it locally', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<MessageActions text="Hello" onFeedback={onFeedback} />);
    const up = screen.getByRole('button', { name: 'Helpful' });
    expect(up).toHaveAttribute('aria-pressed', 'false');
    await user.click(up);
    expect(up).toHaveAttribute('aria-pressed', 'true');
    expect(onFeedback).toHaveBeenCalledWith('up', undefined);
    await user.click(up);
    expect(up).toHaveAttribute('aria-pressed', 'false');
    expect(onFeedback).toHaveBeenCalledTimes(1);
  });

  it('asks for an optional comment on thumbs down and sends it', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<MessageActions text="Hello" onFeedback={onFeedback} />);
    await user.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(onFeedback).toHaveBeenCalledWith('down', undefined);
    await user.type(screen.getByLabelText(/What went wrong/), 'Too vague');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onFeedback).toHaveBeenLastCalledWith('down', 'Too vague');
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Thanks for the feedback.');
  });

  it('closes the comment form with Escape and restores the previous rating when sending fails', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn().mockRejectedValue(new Error('x'));
    render(<MessageActions text="Hello" onFeedback={onFeedback} />);
    const down = screen.getByRole('button', { name: 'Not helpful' });
    await user.click(down);
    expect(down).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not send your feedback.');
  });

  it('copies the text and announces it', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<MessageActions text="Copy me" />);
    expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith('Copy me');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'));
  });

  it('passes the AG-UI message id of the rated assistant message', async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<MessageList run={runOf()} onFeedback={onFeedback} />);
    await user.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(onFeedback).toHaveBeenCalledWith('m1', 'up', undefined);
  });

  it('is axe clean with the comment form open', async () => {
    const user = userEvent.setup();
    const { container } = render(<MessageActions text="Hello" onFeedback={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByRole('button', { name: 'Not helpful' }));
    await expectNoAxeViolations(container);
  });
});

describe('SessionTitle', () => {
  function Harness({ initial }: { initial?: Thread }) {
    const [thread, setThread] = useState(initial);
    return <>
      <SessionTitle thread={thread} onRename={async (id, title) => { setThread((current) => current && { ...current, title }); return id; }} />
      <button type="button" onClick={() => setThread((current) => current && { ...current, title: 'Set by the agent' })}>agent title</button>
    </>;
  }

  it('falls back to "New session" and cannot be renamed without a thread', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'New session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename session' })).toBeNull();
  });

  it('follows the thread title live and renames inline', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial={makeThread({ id: 's', title: null })} />);
    expect(screen.getByRole('heading', { name: 'New session' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'agent title' }));
    expect(screen.getByRole('heading', { name: 'Set by the agent' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    await expectNoAxeViolations(container);
    const input = screen.getByLabelText('Session name');
    await user.clear(input);
    await user.type(input, 'Scope{Enter}');
    expect(await screen.findByRole('heading', { name: 'Scope' })).toBeInTheDocument();
  });

  it('cancels with Escape and reports a failed rename', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn().mockRejectedValue(new Error('x'));
    render(<SessionTitle thread={makeThread({ id: 's', title: 'Scope' })} onRename={onRename} />);
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('heading', { name: 'Scope' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    await user.type(screen.getByLabelText('Session name'), ' 2{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not rename the session.');
    expect(onRename).toHaveBeenCalledWith('s', 'Scope 2');
  });

  it('shows the active thread title in the chat header', () => {
    const thread = makeThread({ id: 's', title: 'Scope' });
    const { rerender } = render(<ChatPanel {...props(runOf(), { threads: [thread], activeThreadId: 's' })} />);
    expect(screen.getByRole('heading', { name: 'Scope' })).toBeInTheDocument();
    rerender(<ChatPanel {...props(runOf(), { threads: [{ ...thread, title: 'Renamed by agent' }], activeThreadId: 's' })} />);
    expect(screen.getByRole('heading', { name: 'Renamed by agent' })).toBeInTheDocument();
  });
});
