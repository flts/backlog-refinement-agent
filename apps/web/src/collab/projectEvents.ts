import { SseParser } from './sse';

/** An event of the project stream (`GET /projects/{id}/events`). */
export interface ProjectEvent {
  /** The `project_events` id; transient events (presence, closed) have none. */
  id?: string;
  type: string;
  projectId?: string;
  actor?: string;
  actorName?: string;
  data: Record<string, unknown>;
  at?: string;
}

export type ProjectEventsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'paused' | 'closed';

/** Reasons after which the server will not accept this user on the stream any more (do not reconnect). */
export type FinalCloseReason = 'member-removed' | 'project-deleted' | 'not-a-member';
export const finalCloseReasons: readonly string[] = ['member-removed', 'project-deleted', 'not-a-member'];

export interface ProjectEventsClientOptions {
  /** Opens the stream; add the auth header and the base URL here (re-read the token on every call). */
  open: (init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  onEvent: (event: ProjectEvent) => void;
  onStatus?: (status: ProjectEventsStatus) => void;
  /** The stream ended for good (`closed` with a final reason, or the server answered 403/404). */
  onFinalClose?: (reason: FinalCloseReason) => void;
  /** No bytes for this long means the connection is dead (the server sends a keepalive every 15 s). */
  keepaliveTimeoutMs?: number;
  defaultRetryMs?: number;
  maxRetryMs?: number;
  /** Replaceable for tests. */
  random?: () => number;
}

export interface ProjectEventsClient {
  start(): void;
  stop(): void;
  /** Closes the connection without forgetting where to resume. */
  pause(): void;
  resume(): void;
  readonly lastEventId: string | undefined;
  readonly status: ProjectEventsStatus;
}

function parseEvent(type: string, id: string | undefined, raw: string): ProjectEvent | undefined {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return undefined; }
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  return { id, type: type !== 'message' ? type : text(record.type) ?? type, projectId: text(record.projectId), actor: text(record.actor), actorName: text(record.actorName), data, at: text(record.at) };
}

/**
 * Fetch-based SSE client with `Last-Event-ID` resume, exponential back-off with jitter, the server's `retry:` hint,
 * keepalive-timeout detection and the `reset` / `closed` protocol events.
 */
export function createProjectEventsClient(options: ProjectEventsClientOptions): ProjectEventsClient {
  const { keepaliveTimeoutMs = 45_000, maxRetryMs = 30_000, random = Math.random } = options;
  let retryMs = options.defaultRetryMs ?? 3000;
  let status: ProjectEventsStatus = 'idle';
  let lastEventId: string | undefined;
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let running = false;

  const setStatus = (next: ProjectEventsStatus) => { if (status !== next) { status = next; options.onStatus?.(next); } };
  const clearTimers = () => { clearTimeout(reconnectTimer); clearTimeout(watchdog); reconnectTimer = undefined; watchdog = undefined; };
  const teardown = () => { clearTimers(); controller?.abort(); controller = undefined; generation += 1; };

  function finish(reason: FinalCloseReason) {
    running = false;
    teardown();
    setStatus('closed');
    options.onFinalClose?.(reason);
  }

  function scheduleReconnect(immediate = false) {
    if (!running) return;
    clearTimers();
    setStatus('reconnecting');
    const ceiling = Math.min(maxRetryMs, retryMs * 2 ** Math.min(attempt, 10));
    const delay = immediate ? 0 : Math.round(ceiling / 2 + random() * (ceiling / 2));
    attempt += 1;
    reconnectTimer = setTimeout(() => { void connect(); }, delay);
  }

  async function connect() {
    if (!running) return;
    clearTimers();
    const mine = ++generation;
    const abort = new AbortController();
    controller = abort;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { if (generation === mine) { generation += 1; abort.abort(); scheduleReconnect(); } }, keepaliveTimeoutMs);
    };
    armWatchdog();

    let routineClose = false;
    let received = false;
    const parser = new SseParser({
      onRetry: (value) => { retryMs = value; },
      onMessage: (message) => {
        if (generation !== mine) return;
        if (message.id !== undefined) lastEventId = message.id;
        const event = parseEvent(message.event, message.id, message.data);
        if (!event) return;
        if (event.type === 'closed') {
          const reason = typeof event.data.reason === 'string' ? event.data.reason : '';
          if (finalCloseReasons.includes(reason)) finish(reason as FinalCloseReason);
          else routineClose = true;
          return;
        }
        options.onEvent(event);
      },
    });

    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
      if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
      const response = await options.open({ headers, signal: abort.signal });
      if (generation !== mine) return;
      if (response.status === 403 || response.status === 404) return finish('not-a-member');
      if (!response.ok || !response.body) throw new Error(`The event stream answered HTTP ${response.status}.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== mine) { void reader.cancel().catch(() => undefined); return; }
        if (done) break;
        if (!received) { received = true; attempt = 0; setStatus('open'); }
        armWatchdog();
        parser.feed(decoder.decode(value, { stream: true }));
        if (!running || generation !== mine) return;
        if (routineClose) { void reader.cancel().catch(() => undefined); break; }
      }
      if (generation !== mine) return;
      scheduleReconnect(routineClose);
    } catch {
      if (generation === mine) scheduleReconnect();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      void connect();
    },
    stop() {
      running = false;
      teardown();
      setStatus('idle');
    },
    pause() {
      if (!running) return;
      running = false;
      teardown();
      setStatus('paused');
    },
    resume() {
      if (running || status !== 'paused') return;
      running = true;
      attempt = 0;
      void connect();
    },
    get lastEventId() { return lastEventId; },
    get status() { return status; },
  };
}
