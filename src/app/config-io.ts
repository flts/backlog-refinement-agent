import { z } from 'zod';
import type { BacklogItem } from '../domain/backlog-item';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';

const typeMap = z.object({
  capability: z.string(),
  feature: z.string(),
  'user-story': z.string(),
  enabler: z.string(),
}).strict();
const templateSchema = z.string().refine((value) => !value.includes('{{'), {
  message: 'Templates must not contain placeholders',
});
const currentSettingsSchema = z.object({
  instructions: z.string(),
  templates: z.object({
    capability: templateSchema,
    feature: templateSchema,
    'user-story': templateSchema,
    enabler: templateSchema,
  }).strict(),
  principles: z.string(),
  typeInstructions: typeMap,
}).strict();
const configSchema = z.object({
  version: z.literal(4),
  settings: currentSettingsSchema,
}).strict();

export function serializeConfig(settings: UserSettings): string {
  return JSON.stringify({ version: 4, settings: currentSettingsSchema.parse(settings) }, null, 2);
}

export function parseConfig(text: string): UserSettings {
  return configSchema.parse(JSON.parse(text)).settings;
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
