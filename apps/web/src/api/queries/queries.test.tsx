import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { TestBacklogApiProvider } from '../BacklogApiProvider';
import { ConflictError } from '../errors';
import { createFakeBacklogApi, makeItem, makeProject, makeSource, type FakeBacklogApi } from '../../test/fakeBacklogApi';
import { testQueryClient } from '../../test/render';
import { backlogKeys } from './keys';
import {
  useAddMember, useChangeItemStatus, useCreateItem, useCreateProject, useDeleteProject, useItem, useItems, useMe, useProjects, useRenameProject, useSources,
  useUpdateItem, useUpdateSource,
} from './index';

function setup(api: FakeBacklogApi) {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <TestBacklogApiProvider client={api.client} queryClient={queryClient}>{children}</TestBacklogApiProvider>;
  return { queryClient, wrapper };
}

describe('query keys', () => {
  it('nest everything of a project under project(id)', () => {
    const project = backlogKeys.project('p');
    for (const key of [backlogKeys.members('p'), backlogKeys.items('p'), backlogKeys.item('p', 'i'), backlogKeys.revisions('p', 'i'), backlogKeys.relationships('p'), backlogKeys.guidance('p'), backlogKeys.guidanceDefaults('p'), backlogKeys.sources('p')]) {
      expect(key.slice(0, project.length)).toEqual([...project]);
    }
    expect(backlogKeys.projects()).not.toEqual(backlogKeys.me());
  });
});

describe('read hooks', () => {
  it('load me, projects, items, an item and sources', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()], sources: [makeSource()] });
    const { wrapper } = setup(api);
    const me = renderHook(() => useMe(), { wrapper });
    const projects = renderHook(() => useProjects(), { wrapper });
    const items = renderHook(() => useItems('p1'), { wrapper });
    const item = renderHook(() => useItem('p1', 'i1'), { wrapper });
    const sources = renderHook(() => useSources('p1'), { wrapper });
    await waitFor(() => expect(sources.result.current.isSuccess && item.result.current.isSuccess && items.result.current.isSuccess && projects.result.current.isSuccess && me.result.current.isSuccess).toBe(true));
    expect(me.result.current.data?.email).toBe('alice@example.test');
    expect(projects.result.current.data?.map((entry) => entry.name)).toEqual(['Alpha']);
    expect(items.result.current.data?.[0]).toMatchObject({ id: 'i1', parentId: null });
    expect(item.result.current.data?.document).toBe('## Summary\nOld');
    expect(sources.result.current.data?.pinnedBudget.limit).toBe(100000);
  });

  it('stay idle without an id', () => {
    const { wrapper } = setup(createFakeBacklogApi());
    const { result } = renderHook(() => useItem(undefined, undefined), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('project mutations', () => {
  it('create, rename (If-Match = project version) and delete update the cache', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject({ version: 3 })] });
    const { wrapper } = setup(api);
    const hook = renderHook(() => ({ list: useProjects(), create: useCreateProject(), rename: useRenameProject(), remove: useDeleteProject() }), { wrapper });
    const list = { result: { get current() { return hook.result.current.list; } } };
    const create = { result: { get current() { return hook.result.current.create; } } };
    const rename = { result: { get current() { return hook.result.current.rename; } } };
    const remove = { result: { get current() { return hook.result.current.remove; } } };
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    await act(async () => { await create.result.current.mutateAsync('  Beta  '); });
    expect(api.state.projects.map((entry) => entry.name)).toEqual(['Alpha', 'Beta']);
    await waitFor(() => expect(list.result.current.data).toHaveLength(2));

    await act(async () => { await rename.result.current.mutateAsync({ project: { id: 'p1', version: 3 }, name: 'Renamed' }); });
    expect(api.callsTo('PATCH', /^\/projects\/p1$/)[0].headers.get('If-Match')).toBe('"3"');
    await waitFor(() => expect(list.result.current.data?.find((entry) => entry.id === 'p1')?.name).toBe('Renamed'));

    await act(async () => { await remove.result.current.mutateAsync({ id: 'p1', version: 4 }); });
    expect(api.callsTo('DELETE', /^\/projects\/p1$/)[0].headers.get('If-Match')).toBe('"4"');
    await waitFor(() => expect(list.result.current.data?.map((entry) => entry.id)).not.toContain('p1'));
  });

  it('rejects a stale rename with ConflictError', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject({ version: 5 })] });
    const { wrapper } = setup(api);
    const rename = renderHook(() => useRenameProject(), { wrapper });
    let caught: unknown;
    await act(async () => { await rename.result.current.mutateAsync({ project: { id: 'p1', version: 4 }, name: 'X' }).catch((error: unknown) => { caught = error; }); });
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).currentVersion).toBe(5);
  });

  it('adding a member sends the email and defaults to contributor', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    api.state.failNext = new Response(JSON.stringify({ email: 'bob@example.test', role: 'contributor', name: null, signedIn: false, addedBy: 'a', addedAt: 'x' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const { wrapper } = setup(api);
    const add = renderHook(() => useAddMember('p1'), { wrapper });
    await act(async () => { await add.result.current.mutateAsync({ email: ' bob@example.test ' }); });
    expect(api.callsTo('POST', /members$/)[0].body).toEqual({ email: 'bob@example.test', role: 'contributor' });
  });
});

describe('item mutations', () => {
  it('create sends only type, title and parent (the server applies the template)', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()] });
    const { wrapper, queryClient } = setup(api);
    const create = renderHook(() => useCreateItem('p1'), { wrapper });
    let created = makeItem();
    await act(async () => { created = await create.result.current.mutateAsync({ type: 'capability', title: '  ' }); });
    expect(api.callsTo('POST', /items$/)[0].body).toEqual({ type: 'capability' });
    expect(created.document).toBe('# capability template');
    expect(queryClient.getQueryData(backlogKeys.item('p1', created.id))).toEqual(created);
  });

  it('update sends If-Match from the known version and writes the new item to the cache', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 7 })] });
    const { wrapper, queryClient } = setup(api);
    const hook = renderHook(() => ({ items: useItems('p1'), update: useUpdateItem('p1') }), { wrapper });
    const items = { result: { get current() { return hook.result.current.items; } } };
    const update = { result: { get current() { return hook.result.current.update; } } };
    await waitFor(() => expect(items.result.current.isSuccess).toBe(true));
    await act(async () => { await update.result.current.mutateAsync({ item: { id: 'i1', version: 7 }, changes: { title: 'Better' } }); });
    expect(api.callsTo('PATCH', /items\/i1$/)[0].headers.get('If-Match')).toBe('"7"');
    expect(queryClient.getQueryData(backlogKeys.item('p1', 'i1'))).toMatchObject({ title: 'Better', version: 8 });
    await waitFor(() => expect(items.result.current.data?.[0]).toMatchObject({ title: 'Better', version: 8 }));
  });

  it('a 409 rejects with ConflictError and refreshes the cache with the current server item', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem({ version: 8, document: 'theirs' })] });
    const { wrapper, queryClient } = setup(api);
    const update = renderHook(() => useUpdateItem('p1'), { wrapper });
    let caught: unknown;
    await act(async () => { await update.result.current.mutateAsync({ item: { id: 'i1', version: 7 }, changes: { document: 'mine' } }).catch((error: unknown) => { caught = error; }); });
    expect(caught).toBeInstanceOf(ConflictError);
    expect(queryClient.getQueryData<{ document: string; version: number }>(backlogKeys.item('p1', 'i1'))).toMatchObject({ document: 'theirs', version: 8 });
  });

  it('a status change is optimistic and rolled back when the server refuses', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], items: [makeItem()] });
    const { wrapper, queryClient } = setup(api);
    const item = renderHook(() => useItem('p1', 'i1'), { wrapper });
    await waitFor(() => expect(item.result.current.isSuccess).toBe(true));
    const change = renderHook(() => useChangeItemStatus('p1'), { wrapper });
    api.state.failNext = new Response(JSON.stringify({ type: '/problems/invalid-status-transition', title: 'Unprocessable', status: 422 }), { status: 422, headers: { 'Content-Type': 'application/problem+json' } });
    await act(async () => { await change.result.current.mutateAsync({ item: { id: 'i1', version: 1 }, status: 'ready' }).catch(() => undefined); });
    expect(queryClient.getQueryData<{ status: string }>(backlogKeys.item('p1', 'i1'))?.status).toBe('draft');
    await act(async () => { await change.result.current.mutateAsync({ item: { id: 'i1', version: 1 }, status: 'refining' }); });
    expect(queryClient.getQueryData<{ status: string }>(backlogKeys.item('p1', 'i1'))?.status).toBe('refining');
  });
});

describe('source mutations', () => {
  it('change the mode with If-Match and update the list optimistically', async () => {
    const api = createFakeBacklogApi({ projects: [makeProject()], sources: [makeSource()] });
    const { wrapper } = setup(api);
    const hook = renderHook(() => ({ sources: useSources('p1'), update: useUpdateSource('p1') }), { wrapper });
    await waitFor(() => expect(hook.result.current.sources.isSuccess).toBe(true));
    const source = hook.result.current.sources.data!.items[0];
    await act(async () => { await hook.result.current.update.mutateAsync({ source, changes: { mode: 'pinned' } }); });
    expect(api.callsTo('PATCH', /sources\/s1$/)[0].headers.get('If-Match')).toBe('"1"');
    await waitFor(() => expect(hook.result.current.sources.data?.items[0].mode).toBe('pinned'));
  });
});
