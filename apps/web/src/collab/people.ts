import { useCallback, useMemo } from 'react';
import { useMembers, type Member } from '../api';

export interface Person { email: string; name?: string | null }

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Up to two letters of a display name or, without a name, of the local part of the email address. */
export function initialsOf(person: Person): string {
  const source = person.name?.trim() || person.email.split('@')[0];
  const letters = source.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  return letters || '?';
}

export const displayName = (person: Person) => person.name?.trim() || person.email;

/** Stable colour slot (0–4) per person, so the same person looks the same everywhere. */
export function toneOf(email: string): number {
  let hash = 0;
  for (const char of normalizeEmail(email)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}

/** Resolves actor emails (revisions, events) to the display names of the project members; unknown emails stay emails. */
export function useMemberDirectory(projectId: string | undefined) {
  const members = useMembers(projectId).data;
  const byEmail = useMemo(() => new Map((members ?? []).map((member: Member) => [normalizeEmail(member.email), member])), [members]);
  const nameOf = useCallback((email: string) => {
    const member = byEmail.get(normalizeEmail(email));
    return member?.name?.trim() || email;
  }, [byEmail]);
  return { members, nameOf };
}
