import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backlogKeys } from '../api';
import { createFakeBacklogApi, makeItem, makeProject } from '../test/fakeBacklogApi';
import { renderWithApi } from '../test/render';
import { applyProjectEvent, remoteChangeText, useProjectEvents, type RemoteItemChange } from './useProjectEvents';
import { RemoteChangeNotice } from './RemoteChangeNotice';
import { collabKeys } from './queryKeys';

const event = (type: string, data: Record<string, unknown> = {}, actor = 'anna@example.test') => ({ id: '1', type, actor, data });

function setup() {
  const queryClient = new QueryClient();
  const spy = vi.spyOn(queryClient, 'invalidateQueries');
  const keys = () => spy.mock.calls.map(([filters]) => filters?.queryKey);
  return { queryClient, keys };
}

describe('applyProjectEvent', () => {
  it('invalidates the whole project (and the project list) on reset', () => {
    const { queryClient, keys } = setup();
    applyProjectEvent(queryClient, 'p1', event('reset', { latestEventId: 5 }), 'me@example.test');
    expect(keys()).toContainEqual(backlogKeys.project('p1'));
    expect(keys()).toContainEqual(backlogKeys.projects());
  });

  it('maps item.updated by somebody else to item, items and revisions and reports the remote change', () => {
    const { queryClient, keys } = setup();
    const change = applyProjectEvent(queryClient, 'p1', { ...event('item.updated', { id: 'i1', version: 8, origin: 'agent' }), actorName: 'Anna' }, 'me@example.test');
    expect(keys()).toEqual([backlogKeys.item('p1', 'i1'), backlogKeys.items('p1'), backlogKeys.revisions('p1', 'i1')]);
    expect(change).toMatchObject({ itemId: 'i1', actorName: 'Anna', origin: 'agent', version: 8 });
    expect(remoteChangeText(change!)).toBe('Updated by Anna via agent');
    expect(remoteChangeText({ actor: 'anna@example.test', origin: 'manual' })).toBe('Updated by anna@example.test');
  });

  it('ignores the echo of our own save but refetches when our cache is behind', () => {
    const { queryClient, keys } = setup();
    queryClient.setQueryData(backlogKeys.item('p1', 'i1'), makeItem({ version: 8 }));
    expect(applyProjectEvent(queryClient, 'p1', event('item.updated', { id: 'i1', version: 8 }, 'Me@Example.test '), 'me@example.test')).toBeUndefined();
    expect(keys()).toEqual([]);
    expect(applyProjectEvent(queryClient, 'p1', event('item.updated', { id: 'i1', version: 9 }, 'me@example.test'), 'me@example.test')).toBeUndefined();
    expect(keys()).toHaveLength(3);
  });

  it.each([
    ['item.created', [backlogKeys.items('p1'), backlogKeys.relationships('p1')]],
    ['item.deleted', [backlogKeys.items('p1'), backlogKeys.relationships('p1')]],
    ['relationship.created', [backlogKeys.relationships('p1')]],
    ['relationship.deleted', [backlogKeys.relationships('p1')]],
    ['member.added', [backlogKeys.members('p1'), backlogKeys.projects()]],
    ['member.updated', [backlogKeys.members('p1'), backlogKeys.projects()]],
    ['member.removed', [backlogKeys.members('p1'), backlogKeys.projects()]],
    ['source.created', [backlogKeys.sources('p1')]],
    ['source.indexed', [backlogKeys.sources('p1')]],
    ['guidance.updated', [backlogKeys.guidance('p1')]],
    ['project.updated', [backlogKeys.project('p1'), backlogKeys.projects()]],
    ['project.deleted', [backlogKeys.projects()]],
  ])('maps %s to targeted invalidation', (type, expected) => {
    const { queryClient, keys } = setup();
    applyProjectEvent(queryClient, 'p1', event(type, { id: 'i1' }), 'me@example.test');
    expect(keys()).toEqual(expected);
  });

  it('stores presence snapshots in the cache without invalidating anything', () => {
    const { queryClient, keys } = setup();
    applyProjectEvent(queryClient, 'p1', event('presence', { users: [{ email: 'anna@example.test', name: 'Anna', itemId: 'i1', state: 'editing' }, { nope: 1 }] }), 'me@example.test');
    expect(queryClient.getQueryData(collabKeys.presence('p1'))).toEqual([{ email: 'anna@example.test', name: 'Anna', itemId: 'i1', state: 'editing' }]);
    expect(keys()).toEqual([]);
  });
});

describe('useProjectEvents', () => {
  afterEach(() => vi.restoreAllMocks());

  function sseFetch(api: ReturnType<typeof createFakeBacklogApi>, body: string) {
    // The fake only serves an idle stream; replace it by one that delivers `body` once.
    const original = api.client.request;
    vi.spyOn(api.client, 'request').mockImplementation((path, init) => {
      if (path.endsWith('/events')) return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); } }), { status: 200 }));
      return original(path, init);
    });
  }

  function Probe({ onGone, onRemote }: { onGone?: () => void; onRemote?: (change: RemoteItemChange) => void }) {
    useProjectEvents('p1', { itemId: 'i1', onProjectGone: onGone, onRemoteItemChange: onRemote });
    return null;
  }

  it('invalidates the cache and reports remote changes of the open item', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()] });
    const frame = (type: string, data: object) => `id: 3\nevent: ${type}\ndata: ${JSON.stringify({ type, actor: 'anna@example.test', actorName: 'Anna', data })}\n\n`;
    sseFetch(api, frame('item.updated', { id: 'i1', version: 2, origin: 'manual' }));
    const onRemote = vi.fn();
    const { queryClient } = renderWithApi(<Probe onRemote={onRemote} />, api);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(onRemote).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'i1', actorName: 'Anna' })));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: backlogKeys.items('p1') }));
  });

  it('reports a final close so the app can leave the project', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    sseFetch(api, 'event: closed\ndata: {"type":"closed","data":{"reason":"member-removed"}}\n\n');
    const onGone = vi.fn();
    renderWithApi(<Probe onGone={onGone} />, api);
    await waitFor(() => expect(onGone).toHaveBeenCalledWith('member-removed'));
  });
});

describe('RemoteChangeNotice', () => {
  it('announces the change politely', () => {
    vi.useFakeTimers();
    const { rerender } = renderWithApi(<RemoteChangeNotice />, createFakeBacklogApi());
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    rerender(<RemoteChangeNotice change={{ key: 1, itemId: 'i1', actor: 'anna@example.test', actorName: 'Anna', origin: 'agent' }} />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByRole('status')).toHaveTextContent('Updated by Anna via agent');
    act(() => { vi.advanceTimersByTime(11_000); });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    vi.useRealTimers();
  });
});
