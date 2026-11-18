import { describe, expect, it } from 'vitest';
import { AgentApiError } from './errors';
import { ThreadRunQueue } from './threadRunQueue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ThreadRunQueue', () => {
  it('rejects a second run on the same thread while one is active (local THREAD_BUSY)', async () => {
    const queue = new ThreadRunQueue();
    const gate = deferred();
    const first = queue.run('t1', () => gate.promise.then(() => 'one'));
    expect(queue.isBusy('t1')).toBe(true);
    const error = await queue.run('t1', async () => 'two').catch((e) => e);
    expect(error).toBeInstanceOf(AgentApiError);
    expect((error as AgentApiError).error).toMatchObject({ code: 'THREAD_BUSY', source: 'local', retryable: true });
    gate.resolve();
    expect(await first).toBe('one');
    expect(queue.isBusy('t1')).toBe(false);
    expect(await queue.run('t1', async () => 'three')).toBe('three');
  });

  it('allows concurrent runs on different threads', async () => {
    const queue = new ThreadRunQueue();
    const gate = deferred();
    const a = queue.run('a', () => gate.promise.then(() => 'a'));
    expect(await queue.run('b', async () => 'b')).toBe('b');
    gate.resolve();
    expect(await a).toBe('a');
  });

  it('queues in order when asked to, and keeps going after a failure', async () => {
    const queue = new ThreadRunQueue('queue');
    const order: string[] = [];
    const gate = deferred();
    const first = queue.run('t', async () => {
      await gate.promise;
      order.push('first');
      throw new Error('boom');
    });
    const second = queue.run('t', async () => void order.push('second'));
    const third = queue.run('t', async () => void order.push('third'));
    gate.resolve();
    await expect(first).rejects.toThrow('boom');
    await Promise.all([second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(queue.isBusy('t')).toBe(false);
  });
});
