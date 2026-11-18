import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../agent';
import { fakeFetch, fakeTokens, sseResponse } from '../agent/testing';
import askAnswer from '../agent/__fixtures__/ask-user.answer.json';
import askHydrate from '../agent/__fixtures__/ask-user.hydrate.json';
import askRun from '../agent/__fixtures__/ask-user.run.json';
import { ChatPanel, MessageList } from '../chat';
import { AskUserArgsSchema, AskUserResultSchema, type AskUserArgs, type AskUserResult } from '../contracts';
import { TestAgentClientProvider, transcriptFromMessages, useAgentRun, type TranscriptEntry } from '../run';
import { expectNoAxeViolations } from '../test/axe';
import { createFakeAgentBackend } from '../test/fakeAgentBackend';
import { makeItem } from '../test/fakeBacklogApi';
import { testQueryClient } from '../test/render';
import { AskUserCard, AskUserInvalidNotice, AskUserSummary, AskUserTranscriptEntry, buildResult, orderedOptions } from '.';

afterEach(() => { delete document.documentElement.dataset.theme; });

const one: AskUserArgs = AskUserArgsSchema.parse({
  questions: [{ id: 'q1', header: 'Scope', question: 'Which users?', options: [{ label: 'Admins', description: 'Only admins' }, { label: 'All' }] }],
});

const three: AskUserArgs = AskUserArgsSchema.parse({
  questions: [
    { id: 'q1', header: 'Scope', question: 'Which users?', rationale: 'It drives the permissions.', relatedSection: 'Acceptance criteria',
      options: [{ label: 'Admins' }, { label: 'Editors', description: 'Can edit' }, { label: 'All' }], recommended: 1 },
    { id: 'q2', header: 'Channels', question: 'Which channels?', multiSelect: true, options: [{ label: 'Email' }, { label: 'SMS' }, { label: 'Push' }] },
    { id: 'q3', header: 'Deadline', question: 'When is it due?', options: [{ label: 'Q1' }, { label: 'Q2' }] },
  ],
});

function setup(args: AskUserArgs = one, props: Partial<Parameters<typeof AskUserCard>[0]> = {}) {
  const onAnswer = vi.fn<(result: AskUserResult) => void>();
  const user = userEvent.setup();
  const view = render(<AskUserCard args={args} onAnswer={onAnswer} {...props} />);
  return { onAnswer, user, ...view };
}

const sent = (onAnswer: ReturnType<typeof setup>['onAnswer']) => onAnswer.mock.calls[0][0];

describe('AskUserCard flows', () => {
  it('answers a single question with Submit', async () => {
    const { onAnswer, user } = setup();
    expect(screen.getByText('Question 1 of 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip all' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Admins/ }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(sent(onAnswer)).toEqual({ status: 'answered', answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }] });
    expect(AskUserResultSchema.safeParse(sent(onAnswer)).success).toBe(true);
  });

  it('steps through three questions, keeps answers with Back/Next and marks the tabs', async () => {
    const { onAnswer, user } = setup(three);
    expect(screen.getByText('Question 1 of 3')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['1Scope', '2Channels', '3Deadline']);
    expect(screen.getByText('Which users?')).toBeInTheDocument();
    expect(screen.getByText('It drives the permissions.')).toBeInTheDocument();
    expect(screen.getByText('Section: Acceptance criteria')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /All/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Scope, answered/ })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Email/ }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('radio', { name: /All/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('checkbox', { name: /Email/ })).toBeChecked();
    await user.click(screen.getByRole('tab', { name: /Deadline/ }));
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
    await user.click(screen.getByRole('radio', { name: /Q2/ }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(onAnswer)).toEqual({
      status: 'answered',
      answers: [
        { questionId: 'q1', selected: ['All'], skipped: false },
        { questionId: 'q2', selected: ['Email'], skipped: false },
        { questionId: 'q3', selected: ['Q2'], skipped: false },
      ],
    });
  });

  it('shows the recommended option first with a badge and keeps original indices in the result', async () => {
    const { onAnswer, user } = setup(three);
    expect(orderedOptions(three.questions[0]).map((entry) => entry.option.label)).toEqual(['Editors', 'Admins', 'All']);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAccessibleName(/Editors/);
    expect(within(radios[0].closest('label')!).getByText('Recommended')).toBeInTheDocument();
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
    expect(screen.getByText('Can edit')).toBeInTheDocument();
    expect(radios[radios.length - 1]).toHaveAccessibleName(/Other/);
    await user.click(radios[0]);
    await user.click(screen.getByRole('button', { name: 'Skip all' }));
    expect(sent(onAnswer).status).toBe('skipped');
    expect(buildResult(three, { q1: { selected: [1], other: false, text: '', skipped: false } }).answers[0].selected).toEqual(['Editors']);
  });

  it('supports multiSelect checkboxes in option order', async () => {
    const { onAnswer, user } = setup({ questions: [three.questions[1]] });
    expect(screen.getByRole('group', { name: 'Which channels?' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Push/ }));
    await user.click(screen.getByRole('checkbox', { name: /Email/ }));
    await user.click(screen.getByRole('checkbox', { name: /Push/ }));
    await user.click(screen.getByRole('checkbox', { name: /SMS/ }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(onAnswer).answers[0]).toEqual({ questionId: 'q2', selected: ['Email', 'SMS'], skipped: false });
  });

  it('selects Other when typing, focuses the textarea, and combines it with checkboxes', async () => {
    const { onAnswer, user } = setup();
    expect(screen.getByRole('radiogroup', { name: 'Which users?' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Admins/ }));
    await user.click(screen.getByRole('radio', { name: /Other/ }));
    const box = screen.getByRole('textbox', { name: /Other answer/ });
    expect(box).toHaveFocus();
    expect(screen.getByRole('radio', { name: /Admins/ })).not.toBeChecked();
    await user.type(box, '  Support agents  ');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(onAnswer).answers[0]).toEqual({ questionId: 'q1', selected: [], freeform: 'Support agents', skipped: false });
  });

  it('typing in the box selects Other without clicking it, and an empty Other is not an answer', async () => {
    const { user } = setup();
    expect(screen.getByRole('radio', { name: /Other/ })).not.toBeChecked();
    await user.click(screen.getByRole('textbox', { name: /Other answer/ }));
    await user.keyboard('x');
    expect(screen.getByRole('radio', { name: /Other/ })).toBeChecked();
    await user.clear(screen.getByRole('textbox', { name: /Other answer/ }));
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });

  it('Skip skips one question; skipping the last one submits with the earlier answers', async () => {
    const { onAnswer, user } = setup(three);
    await user.click(screen.getByRole('radio', { name: /Admins/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByRole('tab', { name: /Channels, skipped/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(sent(onAnswer)).toEqual({
      status: 'answered',
      answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }, { questionId: 'q2', selected: [], skipped: true }, { questionId: 'q3', selected: [], skipped: true }],
    });
  });

  it('Skip all sends status skipped even after answers; skipping the only question is skipped too', async () => {
    const first = setup(three);
    await first.user.click(screen.getAllByRole('radio')[0]);
    await first.user.click(screen.getByRole('button', { name: 'Skip all' }));
    expect(sent(first.onAnswer)).toEqual({ status: 'skipped', answers: three.questions.map((q) => ({ questionId: q.id, selected: [], skipped: true })) });
    first.unmount();
    const second = setup();
    await second.user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(sent(second.onAnswer)).toEqual({ status: 'skipped', answers: [{ questionId: 'q1', selected: [], skipped: true }] });
  });

  it('sends nothing while disabled', async () => {
    const { onAnswer, user } = setup(one, { disabled: true });
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe('AskUserCard keyboard', () => {
  it('1–5 select options (5 = Other) when focus is not in a text field', async () => {
    const { user } = setup(three);
    const card = screen.getByRole('region', { name: 'The agent asks' });
    expect(card).toHaveFocus();
    await user.keyboard('2');
    expect(screen.getByRole('radio', { name: /Admins/ })).toBeChecked();
    await user.keyboard('1');
    expect(screen.getByRole('radio', { name: /Editors/ })).toBeChecked();
    await user.keyboard('4');
    expect(screen.getByRole('radio', { name: /Other/ })).not.toBeChecked();
    await user.keyboard('5');
    expect(screen.getByRole('radio', { name: /Other/ })).toBeChecked();
    expect(screen.getByRole('textbox', { name: /Other answer/ })).toHaveFocus();
    await user.keyboard('3');
    expect(screen.getByRole('textbox', { name: /Other answer/ })).toHaveValue('3');
    expect(screen.getByRole('radio', { name: /All/ })).not.toBeChecked();
  });

  it('1–5 toggle checkboxes of a multiSelect question', async () => {
    const { user } = setup({ questions: [three.questions[1]] });
    await user.keyboard('13');
    expect(screen.getByRole('checkbox', { name: /Email/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Push/ })).toBeChecked();
    await user.keyboard('1');
    expect(screen.getByRole('checkbox', { name: /Email/ })).not.toBeChecked();
  });

  it('Enter goes to the next question and submits on the last; Shift+Enter in Other adds a line', async () => {
    const { onAnswer, user } = setup(three);
    await user.keyboard('1{Enter}');
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Question 3 of 3')).toBeInTheDocument();
    await user.keyboard('5');
    await user.keyboard('a{Shift>}{Enter}{/Shift}b');
    expect(screen.getByRole('textbox', { name: /Other answer/ })).toHaveValue('a\nb');
    expect(onAnswer).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(sent(onAnswer).answers).toEqual([
      { questionId: 'q1', selected: ['Editors'], skipped: false },
      { questionId: 'q2', selected: [], skipped: true },
      { questionId: 'q3', selected: [], freeform: 'a\nb', skipped: false },
    ]);
  });

  it('Enter on the last question without any answer does not submit', async () => {
    const { onAnswer, user } = setup();
    await user.keyboard('{Enter}');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('Esc skips the question', async () => {
    const { onAnswer, user } = setup(three);
    await user.keyboard('{Escape}');
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    await user.keyboard('{Escape}{Escape}');
    expect(sent(onAnswer).status).toBe('skipped');
  });

  it('arrow keys move between question tabs (roving tabindex)', async () => {
    const { user } = setup(three);
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(tabs[2]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[2]).toHaveFocus();
    await user.keyboard('{ArrowLeft}{Home}');
    expect(tabs[0]).toHaveFocus();
  });
});

describe('AskUserCard focus and announcements', () => {
  it('moves focus to the card and announces the questions politely', () => {
    setup(three);
    expect(screen.getByRole('region', { name: 'The agent asks' })).toHaveFocus();
    expect(screen.getByText('The agent has 3 questions')).toBeInTheDocument();
    expect(screen.getAllByRole('status').some((node) => node.textContent === 'The agent has 3 questions')).toBe(true);
  });

  it('says “1 question” for a single question', () => {
    setup(one);
    expect(screen.getByText('The agent has 1 question')).toBeInTheDocument();
  });

  it('does not steal focus from the composer', () => {
    render(<textarea aria-label="composer" autoFocus />);
    const composer = screen.getByLabelText('composer');
    composer.focus();
    render(<AskUserCard args={one} onAnswer={vi.fn()} />);
    expect(composer).toHaveFocus();
  });

  it('announces the next question', async () => {
    const { user } = setup(three);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Question 2 of 3: Which channels?')).toBeInTheDocument();
  });
});

describe('summary, notice and transcript entries', () => {
  const answered: AskUserResult = {
    status: 'answered',
    answers: [{ questionId: 'q1', selected: ['Editors'], skipped: false }, { questionId: 'q2', selected: ['Email', 'SMS'], freeform: 'Fax', skipped: false }, { questionId: 'q3', selected: [], skipped: true }],
  };

  it('summarises header → answers, free text and Skipped', () => {
    render(<AskUserSummary args={three} result={answered} />);
    const summary = within(screen.getByRole('region', { name: 'Your answers' }));
    expect(summary.getByText('Scope').nextSibling).toHaveTextContent('Editors');
    expect(summary.getByText('Channels').nextSibling).toHaveTextContent('Email · SMS · Fax');
    expect(summary.getByText('Deadline').nextSibling).toHaveTextContent('Skipped');
  });

  it('says so when everything was skipped', () => {
    render(<AskUserSummary args={one} result={{ status: 'skipped', answers: [{ questionId: 'q1', selected: [], skipped: true }] }} />);
    expect(screen.getByText('Questions skipped')).toBeInTheDocument();
  });

  it('renders the dismissed note with the questions', () => {
    render(<AskUserSummary args={one} dismissed />);
    expect(screen.getByText('Dismissed — answered in chat')).toBeInTheDocument();
    expect(screen.getByText('Which users?')).toBeInTheDocument();
  });

  it('renders the invalid notice', () => {
    render(<AskUserInvalidNotice />);
    expect(screen.getByRole('note')).toHaveTextContent(/couldn’t be shown/);
  });

  it('transcript entries: answered, dismissed (live and hydrated), pending and foreign results', () => {
    const tool = (extra: Partial<Extract<TranscriptEntry, { kind: 'tool' }>>): Extract<TranscriptEntry, { kind: 'tool' }> =>
      ({ kind: 'tool', id: 'c', toolName: 'ask_user', argsText: '', args: one, status: 'pending', ...extra });
    const { container, rerender } = render(<AskUserTranscriptEntry entry={tool({ status: 'done', result: JSON.stringify({ status: 'answered', answers: [{ questionId: 'q1', selected: ['All'], skipped: false }] }) })} />);
    expect(screen.getByText('All')).toBeInTheDocument();
    rerender(<AskUserTranscriptEntry entry={tool({ status: 'skipped' })} />);
    expect(screen.getByText('Dismissed — answered in chat')).toBeInTheDocument();
    rerender(<AskUserTranscriptEntry entry={tool({ status: 'done', result: 'Tool execution skipped - user provided follow-up message' })} />);
    expect(screen.getByText('Dismissed — answered in chat')).toBeInTheDocument();
    rerender(<AskUserTranscriptEntry entry={tool({})} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AskUserTranscriptEntry entry={tool({ status: 'error', result: 'Error: bad' , args: { nope: true } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('MessageList shows summaries for answered and dismissed calls, but nothing while pending', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'tool', id: 'a', toolName: 'ask_user', argsText: '', args: one, status: 'done', result: JSON.stringify({ status: 'answered', answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }] }) },
      { kind: 'user', id: 'u', text: 'Neither', dismissed: true },
      { kind: 'tool', id: 'b', toolName: 'ask_user', argsText: '', args: one, status: 'skipped' },
      { kind: 'tool', id: 'p', toolName: 'ask_user', argsText: '', args: one, status: 'pending' },
    ];
    render(<MessageList run={{ phase: 'awaitingInput', messages: entries }} />);
    expect(screen.getByRole('region', { name: 'Your answers' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Question dismissed' })).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(2);
  });

  it('is reconstructed from a hydrated transcript (tool call args + tool result message)', () => {
    const transcript = transcriptFromMessages([
      { id: 'm', role: 'assistant', toolCalls: [{ id: 'call', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(three) } }] },
      { id: 't', role: 'tool', toolCallId: 'call', content: JSON.stringify(answered) },
    ]);
    render(<MessageList run={{ phase: 'idle', messages: transcript }} />);
    expect(within(screen.getByRole('region', { name: 'Your answers' })).getByText('Email · SMS · Fax')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'])('has no axe violations in the %s theme (card, summaries, notice)', async (theme) => {
    document.documentElement.dataset.theme = theme;
    const { container, user } = setup(three);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('radio', { name: /Admins/ }));
    await user.click(screen.getByRole('radio', { name: /Other/ }));
    await expectNoAxeViolations(container);
    const summaries = render(<><AskUserSummary args={three} result={{ status: 'answered', answers: three.questions.map((q) => ({ questionId: q.id, selected: [], skipped: true })) }} /><AskUserSummary args={three} dismissed /><AskUserInvalidNotice /></>);
    await expectNoAxeViolations(summaries.container);
  });
});

describe('ChatPanel integration with the fake agent backend', () => {
  const item = makeItem();

  function Harness({ fetchResponses, threadId = 'thr-1' }: { fetchResponses: Response[]; threadId?: string }) {
    const [http] = useState(() => fakeFetch(fetchResponses));
    const [{ backend }] = useState(() => createFakeAgentBackend({ client: createAgentClient({ baseUrl: '/api/agent', agentId: 'a', tokenProvider: fakeTokens(), fetch: http.fetch }) }));
    const [queryClient] = useState(testQueryClient);
    (globalThis as { __http?: typeof http }).__http = http;
    return <QueryClientProvider client={queryClient}><TestAgentClientProvider backend={backend}><Inner threadId={threadId} /></TestAgentClientProvider></QueryClientProvider>;
  }

  function Inner({ threadId }: { threadId: string }) {
    const run = useAgentRun(threadId, { projectId: 'p1', itemId: item.id, itemType: 'feature' });
    const [message, setMessage] = useState('');
    const noop = vi.fn();
    return (
      <ChatPanel className="chat" item={item} threads={[]} activeThreadId={threadId} run={run.state} busy={run.busy} canRetry={run.canRetry} message={message}
        onSelectItem={noop} onNewThread={noop} onSelectThread={noop} onRenameThread={async () => undefined} onDeleteThread={async () => undefined}
        onMessageChange={setMessage} onSubmit={() => { void run.send(message); setMessage(''); }} onContinue={noop} onStop={run.stop} onRetry={noop}
        onAnswer={(result) => void run.answer(result)} onDecideAll={noop} onCreateItem={noop} />
    );
  }

  const requests = () => (globalThis as unknown as { __http: ReturnType<typeof fakeFetch> }).__http.requests;
  const idleHydrate = () => sseResponse([{ type: 'RUN_STARTED', threadId: 'thr-1', runId: 'h' }, { type: 'MESSAGES_SNAPSHOT', messages: [] }, { type: 'RUN_FINISHED', threadId: 'thr-1', runId: 'h' }]);

  it('restores the card after hydration, answers with a tool-message-only run and shows the summary and reply', async () => {
    const user = userEvent.setup();
    render(<Harness fetchResponses={[sseResponse(askHydrate), sseResponse(askAnswer)]} />);
    const card = await screen.findByRole('region', { name: 'The agent asks' });
    expect(within(card).getByText('Which users?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Answer above, or type to reply in your own words')).toBeInTheDocument();
    await user.click(within(card).getByRole('radio', { name: /Admins/ }));
    await user.click(within(card).getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText(/Thanks, scoping/)).toBeInTheDocument();
    const answerRequest = requests()[1].body as { messages: { role: string; toolCallId?: string; content: string }[] };
    expect(answerRequest.messages).toHaveLength(1);
    expect(answerRequest.messages[0]).toMatchObject({ role: 'tool', toolCallId: 'call_ask_1' });
    expect(JSON.parse(answerRequest.messages[0].content)).toEqual({ status: 'answered', answers: [{ questionId: 'q1', selected: ['Admins'], skipped: false }] });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'The agent asks' })).toBeNull());
    expect(within(screen.getByRole('region', { name: 'Your answers' })).getByText('Admins')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Share context/)).toBeInTheDocument();
  });

  it('shows the card when a run ends with a pending ask_user, then the live summary', async () => {
    const user = userEvent.setup();
    render(<Harness fetchResponses={[idleHydrate(), sseResponse(askRun), sseResponse(askAnswer)]} />);
    await waitFor(() => expect(screen.getByLabelText('Message the refinement agent')).toBeEnabled());
    await user.type(screen.getByLabelText('Message the refinement agent'), 'Refine this feature{Enter}');
    const card = await screen.findByRole('region', { name: 'The agent asks' });
    await user.click(within(card).getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText(/Thanks, scoping/)).toBeInTheDocument();
    expect(screen.getByText('Questions skipped')).toBeInTheDocument();
  });

  it('dismisses the card when the user types in the composer instead', async () => {
    const user = userEvent.setup();
    render(<Harness fetchResponses={[sseResponse(askHydrate), sseResponse(askAnswer)]} />);
    await screen.findByRole('region', { name: 'The agent asks' });
    await user.type(screen.getByLabelText('Message the refinement agent'), 'Neither, it depends{Enter}');
    expect(await screen.findByText(/Thanks, scoping/)).toBeInTheDocument();
    const body = requests()[1].body as { messages: { role: string; content: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: 'user', content: '[dismissed question q1] Neither, it depends' });
    expect(screen.queryByRole('region', { name: 'The agent asks' })).toBeNull();
    expect(screen.getByText('Dismissed — answered in chat')).toBeInTheDocument();
    expect(screen.getByText('Neither, it depends')).toBeInTheDocument();
  });

  it('shows a notice instead of the card for invalid arguments', async () => {
    const bad = (askHydrate as { type: string; messages?: { toolCalls?: { function: { arguments: string } }[] }[] }[]).map((event) => JSON.parse(JSON.stringify(event)));
    bad[2].messages![2].toolCalls![0].function.arguments = '{"questions": []}';
    render(<Harness fetchResponses={[sseResponse(bad)]} />);
    expect(await screen.findByRole('note')).toHaveTextContent(/couldn’t be shown/);
    expect(screen.queryByRole('region', { name: 'The agent asks' })).toBeNull();
  });

  it('is axe clean with a pending card in the panel', async () => {
    const { container } = render(<Harness fetchResponses={[sseResponse(askHydrate)]} />);
    await screen.findByRole('region', { name: 'The agent asks' });
    await expectNoAxeViolations(container);
  });
});
