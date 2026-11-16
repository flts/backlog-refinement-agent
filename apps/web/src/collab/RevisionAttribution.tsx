import type { Revision } from '../api';

export const originText: Record<Revision['origin'], string> = { manual: '', agent: 'via agent', restore: 'restored a version' };

/** "Anna via agent", "Frank", "Anna restored a version". */
export function attributionText(revision: Pick<Revision, 'actor' | 'origin'>, nameOf: (email: string) => string): string {
  return [nameOf(revision.actor), originText[revision.origin]].filter(Boolean).join(' ');
}
