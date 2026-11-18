import { useEffect, useRef, useState } from 'react';
import { displayName, normalizeEmail } from './people';
import type { PresenceUser } from './presence';

export const presenceAnnounceDelayMs = 3000;

function nameList(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'}`;
}

/** "Anna joined", "Anna and Ben left", "Anna joined; Ben left". */
export function presenceChangeText(joined: string[], left: string[]): string {
  const parts: string[] = [];
  if (joined.length) parts.push(`${nameList(joined)} joined`);
  if (left.length) parts.push(`${nameList(left)} left`);
  return parts.join('; ');
}

/**
 * Polite, throttled announcement of people joining or leaving the project. Changes are batched for a few seconds (a heartbeat
 * flicker cancels out), the people who are already there on load are not announced, and the text clears itself afterwards.
 */
export function PresenceAnnouncer({ people, delayMs = presenceAnnounceDelayMs }: { people: PresenceUser[]; delayMs?: number }) {
  const [text, setText] = useState('');
  const known = useRef<Map<string, string> | undefined>(undefined);
  const pending = useRef<Map<string, { name: string; joined: boolean }>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const now = new Map(people.map((person) => [normalizeEmail(person.email), displayName(person)] as const));
    const before = known.current;
    known.current = now;
    if (!before) return;
    for (const [email, name] of now) if (!before.has(email)) queue(email, name, true);
    for (const [email, name] of before) if (!now.has(email)) queue(email, name, false);
  }, [people]);

  function queue(email: string, name: string, joined: boolean) {
    const existing = pending.current.get(email);
    if (existing && existing.joined !== joined) pending.current.delete(email);
    else pending.current.set(email, { name, joined });
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }

  function flush() {
    const changes = [...pending.current.values()];
    pending.current.clear();
    const message = presenceChangeText(changes.filter((entry) => entry.joined).map((entry) => entry.name), changes.filter((entry) => !entry.joined).map((entry) => entry.name));
    if (!message) return;
    setText(message);
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setText(''), 8000);
  }

  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(clearTimer.current); }, []);

  return <p className="sr-only" role="status" data-testid="presence-announcer">{text}</p>;
}
