export interface SseMessage {
  /** The `id:` field of this block, when it had one. */
  id?: string;
  /** The `event:` field; `message` when absent (per the SSE specification). */
  event: string;
  /** All `data:` lines joined with a newline. */
  data: string;
}

export interface SseHandlers {
  onMessage: (message: SseMessage) => void;
  /** Called for a valid `retry:` field (milliseconds). */
  onRetry?: (milliseconds: number) => void;
}

/**
 * Incremental `text/event-stream` parser: feed it decoded text chunks of any size (lines may be split anywhere, including
 * between `\r` and `\n`). Comment lines (`: keepalive`) are ignored; a block without data is not dispatched.
 */
export class SseParser {
  private buffer = '';
  private skipLineFeed = false;
  private started = false;
  private id: string | undefined;
  private event = '';
  private data: string[] = [];

  constructor(private readonly handlers: SseHandlers) {}

  feed(chunk: string): void {
    let text = chunk;
    if (!this.started && text) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.skipLineFeed && text) {
      this.skipLineFeed = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    this.buffer += text;
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char !== '\n' && char !== '\r') continue;
      this.line(this.buffer.slice(start, index));
      if (char === '\r') {
        if (this.buffer[index + 1] === '\n') index += 1;
        else if (index + 1 >= this.buffer.length) this.skipLineFeed = true;
      }
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id') { if (!value.includes('\0')) this.id = value; }
    else if (field === 'retry' && /^\d+$/.test(value)) this.handlers.onRetry?.(Number(value));
  }

  private dispatch(): void {
    const { id, event, data } = this;
    this.id = undefined;
    this.event = '';
    this.data = [];
    if (!data.length) return;
    this.handlers.onMessage({ id, event: event || 'message', data: data.join('\n') });
  }
}
