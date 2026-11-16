import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { backlogKeys, useBacklogClient, type Item } from '../api';
import { useAuth } from '../auth';
import { logError } from '../infrastructure/logging';
import { normalizeEmail } from './people';
import { parsePresence, setPresence } from './presence';
import { createProjectEventsClient, type FinalCloseReason, type ProjectEvent, type ProjectEventsStatus } from './projectEvents';
import { useLatest } from './useLatest';

/** A change somebody else (or an agent run of somebody else) made to an item. */
export interface RemoteItemChange { itemId: string; actor: string; actorName?: string; origin: string; version?: number }

export const hiddenPauseMs = 5 * 60_000;

const str = (value: unknown) => typeof value === 'string' ? value : undefined;

/**
 * Maps one project event onto targeted cache invalidation (or a direct cache write for presence).
 * Returns the remote change when the event is an item update by somebody other than `self`.
 */
export function applyProjectEvent(queryClient: QueryClient, projectId: string, event: ProjectEvent, self: string): RemoteItemChange | undefined {
  const invalidate = (queryKey: readonly unknown[], exact = false) => void queryClient.invalidateQueries({ queryKey, exact });
  const ownEmail = normalizeEmail(self);
  switch (event.type) {
    case 'reset':
      invalidate(backlogKeys.project(projectId));
      invalidate(backlogKeys.projects());
      return undefined;
    case 'presence':
      setPresence(queryClient, projectId, parsePresence(event.data.users));
      return undefined;
    case 'item.updated': {
      const itemId = str(event.data.id);
      if (!itemId) { invalidate(backlogKeys.items(projectId)); return undefined; }
      const version = typeof event.data.version === 'number' ? event.data.version : undefined;
      const mine = normalizeEmail(event.actor ?? '') === ownEmail;
      const cached = queryClient.getQueryData<Item>(backlogKeys.item(projectId, itemId));
      // The echo of our own save is already in the cache.
      if (mine && version !== undefined && cached && cached.version >= version) return undefined;
      invalidate(backlogKeys.item(projectId, itemId), true);
      invalidate(backlogKeys.items(projectId));
      invalidate(backlogKeys.revisions(projectId, itemId));
      if (mine) return undefined;
      return { itemId, actor: event.actor ?? '', actorName: event.actorName, origin: str(event.data.origin) ?? 'manual', version };
    }
    case 'item.created':
      invalidate(backlogKeys.items(projectId));
      invalidate(backlogKeys.relationships(projectId));
      return undefined;
    case 'item.deleted': {
      const itemId = str(event.data.id);
      if (itemId) queryClient.removeQueries({ queryKey: backlogKeys.item(projectId, itemId) });
      invalidate(backlogKeys.items(projectId));
      invalidate(backlogKeys.relationships(projectId));
      return undefined;
    }
    case 'relationship.created':
    case 'relationship.deleted':
      invalidate(backlogKeys.relationships(projectId));
      return undefined;
    case 'member.added':
    case 'member.updated':
    case 'member.removed':
      invalidate(backlogKeys.members(projectId));
      invalidate(backlogKeys.projects());
      return undefined;
    case 'source.created':
    case 'source.updated':
    case 'source.deleted':
    case 'source.indexed':
      invalidate(backlogKeys.sources(projectId));
      return undefined;
    case 'guidance.updated':
      invalidate(backlogKeys.guidance(projectId));
      return undefined;
    case 'project.updated':
      invalidate(backlogKeys.project(projectId), true);
      invalidate(backlogKeys.projects());
      return undefined;
    case 'project.deleted':
      invalidate(backlogKeys.projects());
      return undefined;
    default:
      return undefined;
  }
}

/** "Updated by Anna" / "Updated by Anna via agent". */
export function remoteChangeText(change: Pick<RemoteItemChange, 'actor' | 'actorName' | 'origin'>): string {
  const who = change.actorName?.trim() || change.actor || 'someone else';
  return `Updated by ${who}${change.origin === 'agent' ? ' via agent' : change.origin === 'restore' ? ' (restored a version)' : ''}`;
}

export const closeReasonText: Record<FinalCloseReason, string> = {
  'member-removed': 'You were removed from this project.',
  'project-deleted': 'This project was deleted.',
  'not-a-member': 'You no longer have access to this project.',
};

export interface UseProjectEventsOptions {
  /** The open item: `onRemoteItemChange` fires for updates of it. */
  itemId?: string;
  onRemoteItemChange?: (change: RemoteItemChange) => void;
  /** The server ended the stream for good; show the reason and leave the project. */
  onProjectGone?: (reason: FinalCloseReason) => void;
}

/**
 * Subscribes to `GET /projects/{id}/events` for the lifetime of the component and keeps the TanStack Query cache fresh.
 * Resumes with `Last-Event-ID`, backs off with jitter and pauses while the tab has been hidden for more than five minutes.
 */
export function useProjectEvents(projectId: string | undefined, options: UseProjectEventsOptions = {}): { status: ProjectEventsStatus } {
  const client = useBacklogClient();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const latest = useLatest({ options, self: user.email });
  const [status, setStatus] = useState<ProjectEventsStatus>('idle');

  useEffect(() => {
    if (!projectId) return;
    const stream = createProjectEventsClient({
      open: ({ headers, signal }) => client.request(`/projects/${projectId}/events`, { headers, signal }),
      onStatus: setStatus,
      onEvent: (event) => {
        try {
          const change = applyProjectEvent(queryClient, projectId, event, latest.current.self);
          const { itemId, onRemoteItemChange } = latest.current.options;
          if (change && change.itemId === itemId) onRemoteItemChange?.(change);
        } catch (cause) { logError('Could not apply a project event', cause); }
      },
      onFinalClose: (reason) => {
        void queryClient.invalidateQueries({ queryKey: backlogKeys.projects() });
        latest.current.options.onProjectGone?.(reason);
      },
    });
    stream.start();

    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      clearTimeout(hiddenTimer);
      if (document.visibilityState === 'hidden') hiddenTimer = setTimeout(() => stream.pause(), hiddenPauseMs);
      else stream.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(hiddenTimer);
      stream.stop();
    };
  }, [client, queryClient, projectId, latest]);

  return { status };
}
