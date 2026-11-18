import type { AgentClient, Thread, ThreadsApi } from '../agent';
import type { AgentBackend } from '../run/AgentClientProvider';

const stamp = '2026-01-01T00:00:00Z';

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return { id: 't1', title: null, status: 'idle', projectId: 'p1', itemId: 'i1', createdAt: stamp, updatedAt: stamp, ...overrides };
}

/** In-memory threads API (list/create/rename/remove) that records its calls. */
export function createFakeThreadsApi(seed: Thread[] = []) {
  const threads = [...seed];
  const calls: string[] = [];
  let n = 0;
  const api: ThreadsApi = {
    async list(query = {}) {
      calls.push('list');
      return threads.filter((thread) => (!query.projectId || thread.projectId === query.projectId) && (!query.itemId || thread.itemId === query.itemId));
    },
    async create(input) {
      calls.push('create');
      const thread = makeThread({ id: `new-${++n}`, title: input.title ?? null, projectId: input.projectId, itemId: input.itemId, updatedAt: `2026-02-0${n}T00:00:00Z` });
      threads.unshift(thread);
      return thread;
    },
    async rename(threadId, title) {
      calls.push('rename');
      const thread = threads.find((entry) => entry.id === threadId)!;
      thread.title = title;
      return { ...thread };
    },
    async remove(threadId) {
      calls.push('remove');
      threads.splice(threads.findIndex((entry) => entry.id === threadId), 1);
    },
    async feedback(input) {
      return { threadId: input.threadId, messageId: input.messageId, rating: input.rating, comment: input.comment ?? null };
    },
  };
  return { api, threads, calls };
}

/** A client that hydrates every thread as empty and idle; runs are not expected (override `client` to script them). */
export function idleAgentClient(): AgentClient {
  return {
    run: async (input) => ({ status: 'success', threadId: input.threadId, runId: input.runId, state: {}, pendingToolCalls: [], pendingAskUser: null }),
    hydrate: async (threadId) => ({ status: 'idle', threadId, runId: 'hydrate', messages: [], state: { preview: null }, interrupts: [], pendingAskUser: null }),
    abort: () => undefined,
  };
}

export function createFakeAgentBackend(options: { threads?: Thread[]; client?: AgentClient } = {}) {
  const fake = createFakeThreadsApi(options.threads);
  const backend: AgentBackend = { client: options.client ?? idleAgentClient(), threads: fake.api };
  return { backend, ...fake };
}
