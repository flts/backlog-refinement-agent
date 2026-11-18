import { describe, expect, it } from 'vitest';
import { SseParser, type SseMessage } from './sse';

function parse(chunks: string[]) {
  const messages: SseMessage[] = [];
  const retries: number[] = [];
  const parser = new SseParser({ onMessage: (message) => messages.push(message), onRetry: (value) => retries.push(value) });
  for (const chunk of chunks) parser.feed(chunk);
  return { messages, retries };
}

describe('SseParser', () => {
  const wire = 'retry: 3000\n: connected\n\nid: 7\nevent: item.updated\ndata: {"a":1}\n\n: keepalive\n\nevent: presence\ndata: one\ndata: two\n\n';

  it('parses ids, events, multi-line data, comments and retry', () => {
    const { messages, retries } = parse([wire]);
    expect(retries).toEqual([3000]);
    expect(messages).toEqual([
      { id: '7', event: 'item.updated', data: '{"a":1}' },
      { id: undefined, event: 'presence', data: 'one\ntwo' },
    ]);
  });

  it('gives the same result for every split position, one character at a time and with CRLF', () => {
    const expected = parse([wire]);
    for (let cut = 1; cut < wire.length; cut += 1) expect(parse([wire.slice(0, cut), wire.slice(cut)])).toEqual(expected);
    expect(parse([...wire])).toEqual(expected);
    expect(parse([wire.replaceAll('\n', '\r\n')])).toEqual(expected);
    expect(parse(['id: 1\r', '\ndata: x\r', '\n\r', '\n'])).toEqual({ messages: [{ id: '1', event: 'message', data: 'x' }], retries: [] });
  });

  it('ignores blocks without data, invalid retry values and a leading BOM', () => {
    const { messages, retries } = parse(['\uFEFFevent: ping\n\nretry: soon\nretry: 1500\ndata\n\ndata: ok\n\n']);
    expect(retries).toEqual([1500]);
    expect(messages).toEqual([{ id: undefined, event: 'message', data: '' }, { id: undefined, event: 'message', data: 'ok' }]);
  });
});
