import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectEventsClient, type FinalCloseReason, type ProjectEvent } from './projectEvents';

const encoder = new TextEncoder();

/** A controllable event stream response. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const block = (id: number | undefined, type: string, data: object = {}) => `${id === undefined ? '' : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify({ type, projectId: 'p1', actor: 'anna@example.test', data })}\n\n`;

async function settle() { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); }

describe('project events client', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(responses: Array<() => Response | Promise<Response>>) {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const events: ProjectEvent[] = [];
    const finals: FinalCloseReason[] = [];
    const open = vi.fn(async ({ headers }: { headers: Record<string, string> }) => {
      calls.push({ headers });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return next();
    });
    const client = createProjectEventsClient({ open, onEvent: (event) => events.push(event), onFinalClose: (reason) => finals.push(reason), random: () => 0.5 });
    return { client, calls, events, finals, open };
  }

  it('delivers events and resumes with Last-Event-ID after the connection ends', async () => {
    const first = stream();
    const second = stream();
    const { client, calls, events } = setup([() => first.response, () => second.response]);
    client.start();
    await settle();
    first.push(`retry: 1000\n: connected\n\n${block(41, 'item.updated', { id: 'i1' })}${block(undefined, 'presence', { users: [] })}`);
    await settle();
    expect(events.map((event) => [event.id, event.type, event.actor])).toEqual([['41', 'item.updated', 'anna@example.test'], [undefined, 'presence', 'anna@example.test']]);
    expect(client.status).toBe('open');
    expect(calls[0].headers['Last-Event-ID']).toBeUndefined();

    first.end();
    await settle();
    expect(client.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['Last-Event-ID']).toBe('41');
    client.stop();
  });

  it('backs off exponentially with jitter and honours the retry hint after failures', async () => {
    const failing = () => Promise.reject(new Error('offline'));
    const { client, calls } = setup([failing]);
    client.start();
    await settle();
    expect(calls).toHaveLength(1);
    // retry 3000 ms, jitter 0.5 -> 2250 ms for the first retry, 4500 ms for the second
    await vi.advanceTimersByTimeAsync(2249);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4400);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(3);
    client.stop();
  });

  it('passes reset events on (the hook invalidates the whole project) and keeps the new resume id', async () => {
    const first = stream();
    const second = stream();
    const { client, calls, events } = setup([() => first.response, () => second.response]);
    client.start();
    await settle();
    first.push(block(90, 'reset', { latestEventId: 90 }));
    await settle();
    expect(events.map((event) => event.type)).toEqual(['reset']);
    expect(client.lastEventId).toBe('90');
    first.end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls[1].headers['Last-Event-ID']).toBe('90');
    client.stop();
  });

  it.each(['member-removed', 'project-deleted', 'not-a-member'] as const)('stops for good after a final closed event (%s)', async (reason) => {
    const first = stream();
    const { client, calls, finals, events } = setup([() => first.response]);
    client.start();
    await settle();
    first.push(block(undefined, 'closed', { reason }));
    await settle();
    first.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finals).toEqual([reason]);
    expect(events).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(client.status).toBe('closed');
  });

  it('reconnects immediately after the routine max-lifetime close', async () => {
    const first = stream();
    const second = stream();
    const { client, calls, finals } = setup([() => first.response, () => second.response]);
    client.start();
    await settle();
    first.push(block(5, 'item.created') + block(undefined, 'closed', { reason: 'max-lifetime' }));
    await settle();
    await vi.advanceTimersByTimeAsync(1);
    expect(finals).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['Last-Event-ID']).toBe('5');
    client.stop();
  });

  it('treats 403/404 as final and reconnects after other HTTP errors', async () => {
    const forbidden = setup([() => new Response('', { status: 403 })]);
    forbidden.client.start();
    await settle();
    expect(forbidden.finals).toEqual(['not-a-member']);

    const flaky = setup([() => new Response('', { status: 503 }), () => stream().response]);
    flaky.client.start();
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flaky.calls).toHaveLength(2);
    flaky.client.stop();
  });

  it('reconnects when no bytes arrive for 45 seconds', async () => {
    const first = stream();
    const second = stream();
    const { client, calls } = setup([() => first.response, () => second.response]);
    client.start();
    await settle();
    first.push(': keepalive\n\n');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toHaveLength(1);
    first.push(': keepalive\n\n');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    client.stop();
  });

  it('pauses without losing the resume id and resumes on demand', async () => {
    const first = stream();
    const second = stream();
    const { client, calls } = setup([() => first.response, () => second.response]);
    client.start();
    await settle();
    first.push(block(3, 'item.created'));
    await settle();
    client.pause();
    expect(client.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
    client.resume();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['Last-Event-ID']).toBe('3');
    client.stop();
  });
});
