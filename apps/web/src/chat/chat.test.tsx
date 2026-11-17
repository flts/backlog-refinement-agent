import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentErrorFromRunError, type AgentError } from '../agent';
import { initialRunState, type RunState, type TranscriptEntry } from '../run';
import { makeItem } from '../test/fakeBacklogApi';
import { createFakeThreadsApi, makeThread } from '../test/fakeAgentBackend';
import { expectNoAxeViolations } from '../test/axe';
import { ActivityTimeline, ChatPanel, Composer, MarkdownMessage, MessageList, RunErrorCard, ThreadPicker, activityLabel, type ChatPanelProps } from '.';
import type { ActivityRowEntry } from './activity';

const runOf = (overrides: Partial<RunState> = {}): RunState => ({ ...initialRunState('t'), phase: 'idle', ...overrides });
const error = (code: string, extra: Partial<AgentError> = {}): AgentError => ({ ...agentErrorFromRunError({ code, message: 'server text', runId: 'run-123' }), ...extra });

afterEach(() => { vi.useRealTimers(); });

describe('MarkdownMessage', () => {
  it('renders Markdown and GFM', () => {
    render(<MarkdownMessage text={'**bold** and a list\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('never interprets raw HTML', () => {
    const { container } = render(<MarkdownMessage text={'<script>window.hacked=1</script><img src=x onerror=alert(1)> <b>raw</b>'} />);
    expect(container.querySelector('script, img, b')).toBeNull();
    expect(container).toHaveTextContent('<b>raw</b>');
  });

  it('blocks javascript: links and opens safe links in a new tab with rel', () => {
    render(<MarkdownMessage text={'[bad](javascript:alert(1)) [data](data:text/html,x) [rel](/relative) [ok](https://example.com/a) [mail](mailto:a@b.c)'} />);
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'data' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'rel' })).toBeNull();
    const ok = screen.getByRole('link', { name: 'ok' });
    expect(ok).toHaveAttribute('href', 'https://example.com/a');
    expect(ok).toHaveAttribute('target', '_blank');
    expect(ok).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:a@b.c');
  });

  it('turns images into links and never loads them', () => {
    const { container } = render(<MarkdownMessage text={'![chart](https://example.com/c.png) ![evil](javascript:alert(1))'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'chart' })).toHaveAttribute('href', 'https://example.com/c.png');
  });

  it('marks the streaming message busy and shows a caret', () => {
    const { container, rerender } = render(<MarkdownMessage text="Hel" streaming />);
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.stream-caret')).not.toBeNull();
    rerender(<MarkdownMessage text="Hello" />);
    expect(container.firstElementChild).not.toHaveAttribute('aria-busy');
    expect(container.querySelector('.stream-caret')).toBeNull();
  });
});

describe('ActivityTimeline', () => {
  const search = JSON.stringify({ passages: [{ citationId: 'src:1#0', sourceName: 'Pricing.pdf', page: 4, headingPath: 'Plans > Pro', text: 'Pro costs 10 euro.' }] });
  const entries: ActivityRowEntry[] = [
    { kind: 'step', id: 's1', name: 'Reading item', status: 'done' },
    { kind: 'tool', id: 'c1', toolName: 'search_sources', argsText: '', args: { query: 'pricing tiers' }, result: search, status: 'done' },
    { kind: 'tool', id: 'c2', toolName: 'find_similar_items', argsText: '', status: 'done' },
    { kind: 'tool', id: 'c3', toolName: 'get_item_context', argsText: '', status: 'done' },
  ];

  it('labels rows, summarises the run and shows citations in a disclosure', async () => {
    const user = userEvent.setup();
    render(<ActivityTimeline entries={entries} />);
    const toggle = screen.getByRole('button', { name: /Worked · 4 steps/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Reading item')).toBeVisible();
    expect(screen.getByText('Searched sources for “pricing tiers”')).toBeVisible();
    expect(screen.getByText('Checked for similar items')).toBeVisible();
    expect(screen.getByText('Read the item')).toBeVisible();
    expect(screen.getByText('Pricing.pdf')).toBeVisible();
    expect(screen.getByText(/page 4/)).toBeVisible();
    expect(screen.getByText(/Plans > Pro/)).toBeVisible();
    await user.click(screen.getByText('Show passage'));
    expect(screen.getByText('Pro costs 10 euro.')).toBeVisible();
  });

  it('is open with a spinner while a call runs and has accessible status text', () => {
    const running: ActivityRowEntry[] = [{ kind: 'tool', id: 'c', toolName: 'search_sources', argsText: '', args: { query: 'x' }, status: 'running' }];
    const { container } = render(<ActivityTimeline entries={running} />);
    expect(screen.getByRole('button', { name: /Working… · 1 step/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Searching sources for “x”')).toBeVisible();
    expect(container.querySelector('.spinner')).not.toBeNull();
    expect(screen.getByText(/— Running/)).toBeInTheDocument();
  });

  it('reports the elapsed time once the run is done', () => {
    vi.useFakeTimers();
    const running: ActivityRowEntry[] = [{ kind: 'step', id: 's', name: 'Reading item', status: 'running' }];
    const { rerender } = render(<ActivityTimeline entries={running} />);
    act(() => { vi.advanceTimersByTime(12_000); });
    rerender(<ActivityTimeline entries={[{ ...running[0], status: 'done' } as ActivityRowEntry]} />);
    expect(screen.getByRole('button', { name: /Worked for 12 s · 1 step/ })).toBeInTheDocument();
  });

  it('has friendly fallback labels', () => {
    expect(activityLabel({ kind: 'tool', id: 'x', toolName: 'some_new_tool', argsText: '', status: 'done' })).toBe('Used some new tool');
  });
});

describe('RunErrorCard', () => {
  it('shows code and run id, copies the details and retries', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onRetry = vi.fn();
    render(<RunErrorCard error={error('LLM_UNAVAILABLE')} canRetry onRetry={onRetry} />);
    expect(screen.getByText('LLM_UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('run-123').tagName).toBe('CODE');
    await user.click(screen.getByRole('button', { name: 'Copy details' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Run ID: run-123'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('disables Retry when the error is not retryable', () => {
    render(<RunErrorCard error={error('FORBIDDEN')} canRetry={false} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Retry/ })).toBeDisabled();
  });

  it('has an expired-proposal variant', () => {
    render(<RunErrorCard error={error('APPROVAL_RESUME_NOT_FOUND')} canRetry onRetry={vi.fn()} />);
    expect(screen.getByText('Your decision on the proposal could not be applied.')).toBeInTheDocument();
    expect(screen.getByText('APPROVAL_RESUME_NOT_FOUND')).toBeInTheDocument();
    // The recovery card (review/) owns the actions; the error row does not repeat them.
    expect(screen.queryByRole('button', { name: /Retry|Ask again/ })).toBeNull();
  });

  it('counts down the rate-limit Retry-After and enables Retry afterwards', () => {
    vi.useFakeTimers();
    render(<RunErrorCard error={error('RATE_LIMITED', { retryAfterSeconds: 3 })} canRetry onRetry={vi.fn()} />);
    expect(screen.getByText('You can try again in 3 s.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeDisabled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('You can try again in 2 s.')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText(/You can try again/)).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeEnabled();
  });
});

describe('MessageList', () => {
  const messages: TranscriptEntry[] = [
    { kind: 'user', id: 'u1', text: 'Which tier?', dismissed: true },
    { kind: 'step', id: 'step:0', name: 'Reading item', status: 'done' },
    { kind: 'tool', id: 'c', toolName: 'ask_user', argsText: '', status: 'pending' },
    { kind: 'assistant', id: 'a1', text: 'Here is **the plan**', streaming: false },
    { kind: 'error', id: 'e1', error: error('INTERNAL') },
  ];

  it('renders bubbles, a collapsed timeline without hidden tools, notes and the error card', () => {
    render(<MessageList run={{ phase: 'error', messages }} canRetry onRetry={vi.fn()} />);
    expect(screen.getByText('Which tier?')).toBeInTheDocument();
    expect(screen.getByText('Answered in chat')).toBeInTheDocument();
    expect(screen.getByText('the plan').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: /1 step/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Run error' })).toBeInTheDocument();
    expect(screen.queryByText(/dismissed question/)).toBeNull();
  });

  it('shows a skeleton while hydrating and the restored transcript afterwards', () => {
    const { rerender } = render(<MessageList run={{ phase: 'hydrating', messages: [] }} />);
    expect(screen.getByTestId('conversation-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    rerender(<MessageList run={{ phase: 'idle', messages: [{ kind: 'user', id: 'u', text: 'restored' }] }} />);
    expect(screen.queryByTestId('conversation-skeleton')).toBeNull();
    expect(screen.getByText('restored')).toBeInTheDocument();
  });

  it('streams into a busy message', () => {
    render(<MessageList run={{ phase: 'running', messages: [{ kind: 'assistant', id: 'a', text: 'Partial', streaming: true }] }} />);
    expect(screen.getByText('Partial').closest('.markdown')).toHaveAttribute('aria-busy', 'true');
  });

  it('follows new content, stops following when the user scrolls up and offers Jump to latest', () => {
    const dims = { scrollHeight: 1000, clientHeight: 200 };
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => dims.scrollHeight);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => dims.clientHeight);
    const entry = (text: string): RunState => ({ ...runOf({ phase: 'running' }), messages: [{ kind: 'assistant', id: 'a', text, streaming: true }] });
    const { rerender } = render(<MessageList run={entry('one')} />);
    const log = screen.getByRole('log');
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    log.scrollTop = 100;
    fireEvent.scroll(log);
    dims.scrollHeight = 1200;
    rerender(<MessageList run={entry('one two')} />);
    expect(log.scrollTop).toBe(100);
    const jump = screen.getByRole('button', { name: /Jump to latest/ });

    fireEvent.click(jump);
    expect(log.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('ThreadPicker', () => {
  function Harness({ seed = [makeThread({ id: 'a', title: 'Scope', updatedAt: new Date().toISOString() }), makeThread({ id: 'b', title: null, status: 'awaiting_input', updatedAt: new Date(Date.now() - 3_600_000 * 3).toISOString() })], onSelect = vi.fn() }) {
    const fake = createFakeThreadsApi(seed);
    const [threads, setThreads] = useState(seed);
    const [active, setActive] = useState('a');
    return (
      <ThreadPicker threads={threads} activeThreadId={active}
        onSelect={(id) => { onSelect(id); setActive(id); }}
        onCreate={() => void fake.api.create({ projectId: 'p1', itemId: 'i1' }).then((thread) => setThreads([thread, ...threads]))}
        onRename={async (id, title) => { const updated = await fake.api.rename(id, title); setThreads(threads.map((thread) => (thread.id === id ? updated : thread))); }}
        onDelete={async (id) => { await fake.api.remove(id); setThreads(threads.filter((thread) => thread.id !== id)); }} />
    );
  }

  it('lists sessions with titles, relative time, badges and the privacy note', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Sessions/ }));
    const panel = within(screen.getByRole('group', { name: 'Your refinement sessions' }));
    expect(panel.getByText('Scope')).toBeInTheDocument();
    expect(panel.getByText('Untitled session')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(screen.getByText('3 hours ago')).toBeInTheDocument();
    expect(screen.getByText('Awaiting input')).toBeInTheDocument();
    expect(screen.getByText('Only you can see your sessions.')).toBeInTheDocument();
  });

  it('switches and creates sessions', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Sessions/ }));
    await user.click(within(screen.getByRole('group', { name: 'Your refinement sessions' })).getByRole('button', { name: /^Untitled session/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
    await user.click(screen.getByRole('button', { name: 'New session' }));
    await user.click(await screen.findByRole('button', { name: /Sessions\. Current/ }));
    expect(await screen.findAllByRole('listitem')).toHaveLength(3);
  });

  it('renames inline', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Sessions/ }));
    await user.click(screen.getByRole('button', { name: 'Rename Scope' }));
    const box = screen.getByRole('textbox', { name: 'Session name' });
    await user.clear(box);
    await user.type(box, 'Pricing{Enter}');
    expect(await screen.findByRole('button', { name: 'Rename Pricing' })).toBeInTheDocument();
  });

  it('deletes only after confirmation', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Sessions/ }));
    await user.click(screen.getByRole('button', { name: 'Delete Scope' }));
    expect(screen.getByText(/Delete “Scope”/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Rename Scope' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Scope' }));
    await user.click(screen.getByRole('button', { name: 'Delete session' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rename Scope' })).toBeNull());
  });

  it('closes with Escape and returns focus to the trigger; is axe clean', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Sessions/ });
    await user.click(trigger);
    await expectNoAxeViolations(container);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Your refinement sessions' })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('Composer stop', () => {
  it('stops the run with Esc and keeps the box focusable while running', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer value="" busy running reason="The agent is working. Press Esc to stop it." onChange={vi.fn()} onSubmit={vi.fn()} onStop={onStop} />);
    const box = screen.getByLabelText('Message the refinement agent');
    expect(box).toBeEnabled();
    expect(box).toHaveAccessibleDescription('The agent is working. Press Esc to stop it.');
    await user.click(box);
    await user.keyboard('{Escape}');
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('ignores Esc when idle', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<Composer value="" busy={false} onChange={vi.fn()} onSubmit={vi.fn()} onStop={onStop} />);
    await user.click(screen.getByLabelText('Message the refinement agent'));
    await user.keyboard('{Escape}');
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('ChatPanel', () => {
  const item = makeItem();
  const props = (run: RunState, overrides: Partial<ChatPanelProps> = {}): ChatPanelProps => ({
    className: 'chat', item, threads: [], run, busy: run.phase === 'running' || run.phase === 'hydrating', canRetry: false, message: '',
    onSelectItem: vi.fn(), onNewThread: vi.fn(), onSelectThread: vi.fn(), onRenameThread: vi.fn(), onDeleteThread: vi.fn(), onMessageChange: vi.fn(), onSubmit: vi.fn(), onContinue: vi.fn(),
    onStop: vi.fn(), onRetry: vi.fn(), onAnswer: vi.fn(), onDecideAll: vi.fn(), onCreateItem: vi.fn(), ...overrides,
  });

  it('announces phase changes politely and errors assertively', () => {
    const { rerender } = render(<ChatPanel {...props(runOf({ phase: 'hydrating' }))} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
    rerender(<ChatPanel {...props(runOf())} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
    rerender(<ChatPanel {...props(runOf({ phase: 'running' }))} />);
    expect(screen.getByRole('status')).toHaveTextContent('Agent is working');
    rerender(<ChatPanel {...props(runOf({ phase: 'idle' }))} />);
    expect(screen.getByRole('status')).toHaveTextContent('Agent replied');
    // The ask_user and review cards announce themselves, so the panel stays quiet (no double announcement).
    rerender(<ChatPanel {...props(runOf({ phase: 'awaitingInput' }))} />);
    expect(screen.getAllByRole('status').every((node) => node.textContent !== 'Agent needs your input')).toBe(true);
    rerender(<ChatPanel {...props(runOf({ phase: 'awaitingReview' }))} />);
    expect(screen.getAllByRole('status').every((node) => node.textContent !== 'Review proposed changes')).toBe(true);
    rerender(<ChatPanel {...props(runOf({ phase: 'error', lastError: error('INTERNAL') }))} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Something went wrong/);
  });

  it('does not announce an expired proposal assertively: its recovery card takes focus and announces itself', () => {
    const lastError = error('APPROVAL_RESUME_NOT_FOUND');
    const expired = { id: 'af-1', toolCallId: 'c', toolName: 'propose_document_changes', args: {}, expired: true };
    render(<ChatPanel {...props(runOf({ phase: 'error', lastError, interrupts: [expired], messages: [{ kind: 'error', id: 'e', error: lastError }] }))} />);
    expect(screen.getByRole('alert')).toHaveTextContent('');
    expect(screen.getByRole('heading', { name: 'This proposal can no longer be applied' })).toHaveFocus();
  });

  it('shows the hydration skeleton and then the restored transcript', () => {
    const { rerender } = render(<ChatPanel {...props(runOf({ phase: 'hydrating' }))} />);
    expect(screen.getByTestId('conversation-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/Let’s make this item/)).toBeNull();
    rerender(<ChatPanel {...props(runOf({ messages: [{ kind: 'assistant', id: 'a', text: 'Restored answer', streaming: false }] }))} />);
    expect(screen.getByText('Restored answer')).toBeInTheDocument();
  });

  it('has a Stop button while running that stops the agent', async () => {
    const user = userEvent.setup();
    const p = props(runOf({ phase: 'running' }));
    render(<ChatPanel {...p} />);
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(p.onStop).toHaveBeenCalledOnce();
    await user.type(screen.getByLabelText('Message the refinement agent'), '{Escape}');
    expect(p.onStop).toHaveBeenCalledTimes(2);
  });

  it.each(['light', 'dark'])('is axe clean in the %s theme with a rich transcript', async (theme) => {
    document.documentElement.dataset.theme = theme;
    const messages: TranscriptEntry[] = [
      { kind: 'user', id: 'u', text: 'Hi' },
      { kind: 'step', id: 's', name: 'Reading item', status: 'done' },
      { kind: 'tool', id: 'c', toolName: 'search_sources', argsText: '', args: { query: 'q' }, status: 'done', result: JSON.stringify({ passages: [{ citationId: 'src:1#0', sourceName: 'Doc', text: 'Quote' }] }) },
      { kind: 'assistant', id: 'a', text: '# Title\n\nSome [link](https://example.com) and `code`.\n\n| a | b |\n|---|---|\n| 1 | 2 |', streaming: false },
      { kind: 'error', id: 'e', error: error('RATE_LIMITED', { retryAfterSeconds: 30 }) },
    ];
    const { container } = render(<ChatPanel {...props(runOf({ phase: 'error', messages, lastError: error('RATE_LIMITED') }), { threads: [makeThread({ id: 't', title: 'Scope' })], activeThreadId: 't', canRetry: true })} />);
    await expectNoAxeViolations(container);
    expect(within(container).getByRole('log')).toBeInTheDocument();
    delete document.documentElement.dataset.theme;
  });
});
