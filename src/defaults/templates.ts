import type { BacklogItemType } from '../domain/backlog-item';

const sourceTemplates = import.meta.glob('./templates/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const templateFiles: Record<BacklogItemType, string> = {
  capability: './templates/capability.md',
  feature: './templates/feature.md',
  'user-story': './templates/user-story.md',
  enabler: './templates/enabler.md',
};

export const defaultBacklogTemplates = Object.fromEntries(
  Object.entries(templateFiles).map(([type, path]) => {
    const template = sourceTemplates[path];
    if (typeof template !== 'string') {
      throw new Error(`Missing default backlog template: ${path}`);
    }
    return [type, template.trim()];
  }),
) as Record<BacklogItemType, string>;

export function getDefaultBacklogTemplate(type: BacklogItemType): string {
  return defaultBacklogTemplates[type];
}
