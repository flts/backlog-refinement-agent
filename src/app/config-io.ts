import { z } from 'zod';
import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { defaultBacklogTemplates } from '../defaults/templates';
import { defaultPrinciples, defaultTypeInstructions } from '../defaults/instructions';
import { convertPlaceholderTemplate } from '../domain/document';
import { itemTypes } from './labels';

const typeMap = z.object({
  capability: z.string(), feature: z.string(), 'user-story': z.string(), enabler: z.string(),
});
const v3Schema = z.object({
  version: z.union([z.literal(3), z.literal(4)]),
  settings: z.object({ templates: typeMap, instructions: z.string(), principles: z.string(), typeInstructions: typeMap }),
});
const v2Schema = z.object({
  version: z.literal(2),
  settings: z.object({ templates: typeMap, instructions: z.string() }),
});
const v1Schema = z.object({
  version: z.literal(1),
  settings: z.object({
    templates: z.object({
      capability: z.array(z.string()), feature: z.array(z.string()),
      'user-story': z.array(z.string()), enabler: z.array(z.string()),
    }),
    instructions: z.string().optional(),
  }),
});

export function serializeConfig(settings: UserSettings): string {
  return JSON.stringify({ version: 4, settings }, null, 2);
}

export function parseConfig(text: string): UserSettings {
  const parsed = z.union([v3Schema, v2Schema, v1Schema]).parse(JSON.parse(text));
  const templates = parsed.version !== 1
    ? Object.fromEntries(Object.entries(parsed.settings.templates).map(([type, value]) => [type, convertPlaceholderTemplate(value)])) as UserSettings['templates']
    : Object.fromEntries(
      itemTypes.map((type: BacklogItemType) => [
        type,
        parsed.settings.templates[type].length
          ? parsed.settings.templates[type].map((section) => `## ${section}`).join('\n\n')
          : defaultBacklogTemplates[type],
      ]),
    ) as UserSettings['templates'];
  return {
    instructions: parsed.settings.instructions ?? '',
    templates,
    principles: 'principles' in parsed.settings ? parsed.settings.principles : defaultPrinciples,
    typeInstructions: 'typeInstructions' in parsed.settings ? parsed.settings.typeInstructions : defaultTypeInstructions,
  };
}

export function markdownFor(item: BacklogItem): string {
  return `# ${item.title}\n\n${item.description}`.trim();
}

export function markdownFilename(item: BacklogItem): string {
  const slug = item.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'backlog-item';
  return `${slug}.md`;
}

export function downloadFile(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}
