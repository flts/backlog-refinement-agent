import { describe, expect, it } from 'vitest';
import { FORWARDED_PROPS_MAX_LENGTH } from '../contracts';
import { askUserTool } from './askUserTool';
import { buildForwardedProps, editedArgsFor, RunInputBuilder } from './runInput';

const builder = () => {
  let n = 0;
  return new RunInputBuilder({ threadId: 't1', projectId: 'p1', itemId: 'i1', itemType: 'user-story', newId: () => `id-${++n}` });
};

describe('RunInputBuilder', () => {
  it('always sends threadId, runId, state with preview null, ask_user and no context', () => {
    const request = builder().userMessage('hello', 'refine');
    expect(request).toMatchObject({
      threadId: 't1',
      runId: 'id-2',
      state: { schemaVersion: 1, projectId: 'p1', itemId: 'i1', itemType: 'user-story', preview: null },
      tools: [askUserTool],
      forwardedProps: { intent: 'refine' },
      messages: [{ id: 'id-1', role: 'user', content: 'hello' }],
    });
    expect(request).not.toHaveProperty('context');
    expect(request).not.toHaveProperty('resume');
  });

  it('uses fresh uuids by default', () => {
    const a = new RunInputBuilder({ threadId: 't', projectId: 'p', itemId: 'i' }).hydrate();
    const b = new RunInputBuilder({ threadId: 't', projectId: 'p', itemId: 'i' }).hydrate();
    expect(a.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.runId).not.toBe(b.runId);
  });

  it('builds the ask_user tool from the shared schema', () => {
    expect(askUserTool.name).toBe('ask_user');
    expect(askUserTool.parameters.properties.questions.maxItems).toBe(3);
  });

  it('guards forwardedProps (contract validation and the 512 character limit)', () => {
    expect(JSON.stringify(buildForwardedProps('breakdown', 'feature')).length).toBeLessThanOrEqual(FORWARDED_PROPS_MAX_LENGTH);
    expect(buildForwardedProps()).toEqual({});
    expect(() => buildForwardedProps('nope' as never)).toThrow();
    expect(() => buildForwardedProps('refine', 'x'.repeat(600) as never)).toThrow();
  });

  it('builds a tool-message-only ask_user answer and validates the result', () => {
    const request = builder().askUserAnswer('call_1', { status: 'answered', answers: [{ questionId: 'q1', selected: ['A'], skipped: false }] });
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    expect(() => builder().askUserAnswer('call_1', { status: 'maybe' } as never)).toThrow();
  });

  it('builds the dismissal as a user message only, prefixed with the question ids', () => {
    const request = builder().askUserDismissedWithMessage('Actually, focus on performance', ['q1', 'q2']);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({ role: 'user', content: '[dismissed question q1, q2] Actually, focus on performance' });
    expect(request.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('builds resume entries: resolved needs a payload, editedArgs is carried, cancelled has none', () => {
    const request = builder().resume([
      { interruptId: 'af-1', approved: true, editedArgs: { summary: 's', base_version: 1, sections: [] } },
      { interruptId: 'af-2', approved: false },
      { interruptId: 'af-3', cancelled: true },
    ]);
    expect(request.messages).toEqual([]);
    expect(request.resume).toEqual([
      { interruptId: 'af-1', status: 'resolved', payload: { approved: true, editedArgs: { summary: 's', base_version: 1, sections: [] } } },
      { interruptId: 'af-2', status: 'resolved', payload: { approved: false } },
      { interruptId: 'af-3', status: 'cancelled' },
    ]);
    expect(() => builder().resume([])).toThrow();
  });

  it('editedArgsFor keeps every original key (full replacement)', () => {
    const args = { summary: 's', base_version: 7, sections: [1, 2] };
    expect(editedArgsFor({ args }, { sections: [1] })).toEqual({ summary: 's', base_version: 7, sections: [1] });
  });

  it('cancelPendingThenMessage yields a cancel resume run followed by the message run', () => {
    const { cancel, message } = builder().cancelPendingThenMessage([{ id: 'af-1' }], 'new direction');
    expect(cancel.resume).toEqual([{ interruptId: 'af-1', status: 'cancelled' }]);
    expect(cancel.messages).toEqual([]);
    expect(message.messages[0]).toMatchObject({ role: 'user', content: 'new direction' });
    expect(message.resume).toBeUndefined();
    expect(cancel.runId).not.toBe(message.runId);
  });

  it('continue sends the intent with its default prompt; hydrate has no messages, resume or tools', () => {
    const request = builder().continue('breakdown', 'user-story');
    expect(request.forwardedProps).toEqual({ intent: 'breakdown', childType: 'user-story' });
    expect(request.messages).toHaveLength(1);
    const hydrate = builder().hydrate();
    expect(hydrate).toMatchObject({ messages: [], tools: [] });
    expect(hydrate).not.toHaveProperty('resume');
  });

  it('rejects empty user messages', () => {
    expect(() => builder().userMessage('   ')).toThrow();
  });
});
