import type { BacklogItemType } from '../domain/backlog-item';

const sources = import.meta.glob('./instructions/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function load(name: string): string {
  const source = sources[`./instructions/${name}.md`];
  if (typeof source !== 'string') throw new Error(`Missing default instructions: ${name}.md`);
  return source.trim();
}

export const defaultPrinciples = load('principles');

export const defaultTypeInstructions: Record<BacklogItemType, string> = {
  capability: load('capability'),
  feature: load('feature'),
  'user-story': load('user-story'),
  enabler: load('enabler'),
};
