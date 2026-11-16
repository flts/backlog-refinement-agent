import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useBacklogClient, type BacklogClient } from '../api';
import { useAuth } from '../auth';
import { logError } from '../infrastructure/logging';
import { normalizeEmail } from './people';
import { collabKeys } from './queryKeys';

export type PresenceState = 'viewing' | 'editing';
export interface PresenceUser { email: string; name?: string | null; itemId?: string | null; state: string }

export const presenceIntervalMs = 20_000;

export function parsePresence(value: unknown): PresenceUser[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PresenceUser[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { email, name, itemId, state } = entry as Record<string, unknown>;
    if (typeof email !== 'string') return [];
    return [{ email, name: typeof name === 'string' ? name : null, itemId: typeof itemId === 'string' ? itemId : null, state: typeof state === 'string' ? state : 'viewing' }];
  });
}

export function setPresence(queryClient: QueryClient, projectId: string, users: PresenceUser[]) {
  queryClient.setQueryData(collabKeys.presence(projectId), users);
}

/**
 * Sends the presence heartbeat for the signed-in user: immediately and whenever the item or state changes, then every 20 s
 * (the server forgets a user after 45 s). Leaves with `DELETE` (keepalive, so it survives a closing tab) on unmount or project switch.
 */
export function usePresence(projectId: string | undefined, itemId: string | undefined, state: PresenceState = 'viewing') {
  const client = useBacklogClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;
    const leave = () => { void leavePresence(client, projectId); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); leave(); };
  }, [client, projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const beat = () => {
      client.request(`/projects/${projectId}/presence`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: itemId ?? null, state }),
      }).then(async (response) => {
        if (response.ok && active) setPresence(queryClient, projectId, parsePresence(((await response.json()) as { users?: unknown }).users));
      }).catch((cause: unknown) => logError('Presence heartbeat failed', cause));
    };
    beat();
    const timer = setInterval(beat, presenceIntervalMs);
    return () => { active = false; clearInterval(timer); };
  }, [client, queryClient, projectId, itemId, state]);
}

function leavePresence(client: BacklogClient, projectId: string): Promise<unknown> {
  return client.request(`/projects/${projectId}/presence`, { method: 'DELETE', keepalive: true }).catch((cause: unknown) => logError('Leaving presence failed', cause));
}

/** The other people currently in the project (one entry per person and item), from the heartbeat answers and `presence` events. */
export function useProjectPresence(projectId: string | undefined) {
  const { user } = useAuth();
  const self = normalizeEmail(user.email);
  const { data } = useQuery<PresenceUser[]>({ queryKey: collabKeys.presence(projectId ?? ''), queryFn: skipToken, enabled: Boolean(projectId) });
  const others = useMemo(() => {
    const seen = new Set<string>();
    return (data ?? []).filter((entry) => {
      const key = `${normalizeEmail(entry.email)}|${entry.itemId ?? ''}`;
      if (normalizeEmail(entry.email) === self || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [data, self]);
  /** One entry per person (their most active item: editing wins), for the avatar row of the topbar. */
  const people = useMemo(() => {
    const byEmail = new Map<string, PresenceUser>();
    for (const entry of others) {
      const key = normalizeEmail(entry.email);
      const known = byEmail.get(key);
      if (!known || (known.state !== 'editing' && entry.state === 'editing')) byEmail.set(key, entry);
    }
    return [...byEmail.values()];
  }, [others]);
  const byItem = useMemo(() => {
    const map = new Map<string, PresenceUser[]>();
    for (const entry of others) if (entry.itemId) map.set(entry.itemId, [...(map.get(entry.itemId) ?? []), entry]);
    return map;
  }, [others]);
  const forItem = useCallback((id: string | undefined) => (id && byItem.get(id)) || [], [byItem]);
  return { people, byItem, forItem };
}
