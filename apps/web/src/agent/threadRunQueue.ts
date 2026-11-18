import { AgentApiError, agentErrorThreadBusyLocal } from './errors';

export type BusyPolicy = 'reject' | 'queue';

interface Slot {
  active: Promise<unknown>;
}

/**
 * Serialises runs per thread (spike #18: the agent-service does not guard concurrent runs on one thread).
 * `reject` fails a second run immediately with THREAD_BUSY (a local 409); `queue` runs it after the active one.
 */
export class ThreadRunQueue {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly policy: BusyPolicy = 'reject') {}

  isBusy(threadId: string): boolean {
    return this.slots.has(threadId);
  }

  async run<T>(threadId: string, task: () => Promise<T>, policy: BusyPolicy = this.policy): Promise<T> {
    const slot = this.slots.get(threadId);
    if (slot && policy === 'reject') throw new AgentApiError(agentErrorThreadBusyLocal());
    const previous = slot?.active ?? Promise.resolve();
    const result = previous.then(task, task);
    const next: Slot = { active: result.catch(() => undefined) };
    this.slots.set(threadId, next);
    try {
      return await result;
    } finally {
      if (this.slots.get(threadId) === next) this.slots.delete(threadId);
    }
  }
}
