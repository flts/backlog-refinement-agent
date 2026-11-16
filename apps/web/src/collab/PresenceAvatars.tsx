import { displayName, initialsOf, toneOf } from './people';
import type { PresenceUser } from './presence';

const stateText = (state: string) => state === 'editing' ? 'editing' : 'viewing';

export function Avatar({ person, title }: { person: { email: string; name?: string | null }; title?: string }) {
  return <span className={`collab-avatar tone-${toneOf(person.email)}`} title={title ?? `${displayName(person)} (${person.email})`} aria-hidden="true">{initialsOf(person)}</span>;
}

/** "Anna is viewing", "Anna and Ben are editing", "Anna, Ben and 2 others are viewing". */
export function presenceSentence(people: PresenceUser[]): string {
  if (!people.length) return '';
  const editing = people.filter((person) => person.state === 'editing');
  const group = editing.length ? editing : people;
  const names = group.map(displayName);
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} ${stateText(group[0].state)}`;
}

/**
 * Initials avatars of the other people in the project: at most `max`, then "+N". An accessible list; the tooltip
 * (`title`) shows name and email. `showLabel` adds a sentence ("Anna is editing"), used in the item header.
 */
export function PresenceAvatars({ people, max = 4, label = 'People in this project', showLabel = false }: { people: PresenceUser[]; max?: number; label?: string; showLabel?: boolean }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const rest = people.slice(max);
  return <div className="presence">
    <ul className="presence-avatars" aria-label={label}>
      {shown.map((person) => <li key={`${person.email}|${person.itemId ?? ''}`} title={`${displayName(person)} (${person.email}) – ${stateText(person.state)}`}>
        <Avatar person={person} /><span className="sr-only">{displayName(person)}, {stateText(person.state)}</span>
      </li>)}
      {rest.length > 0 && <li className="presence-more" title={rest.map(displayName).join(', ')}><span aria-hidden="true">+{rest.length}</span><span className="sr-only">and {rest.length} more: {rest.map(displayName).join(', ')}</span></li>}
    </ul>
    {showLabel && <span className="presence-text">{presenceSentence(people)}</span>}
  </div>;
}

/** Small dot in a backlog tree row for an item other people have open. */
export function PresenceDot({ people }: { people: PresenceUser[] }) {
  if (!people.length) return null;
  const editing = people.some((person) => person.state === 'editing');
  return <span className={`presence-dot ${editing ? 'editing' : ''}`} role="img" aria-label={presenceSentence(people)} title={presenceSentence(people)} />;
}
