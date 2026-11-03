import { z } from 'zod';
import { convertPlaceholderTemplate } from '../../domain/document';
import { defaultBacklogTemplates } from '../../defaults/templates';
import { defaultPrinciples, defaultTypeInstructions } from '../../defaults/instructions';
import { BacklogDatabase, backlogDatabase, type StoredAppSettings } from './database';

const templatesSchema = z.object({
  capability: z.union([z.string(), z.array(z.string())]).optional(),
  feature: z.union([z.string(), z.array(z.string())]).optional(),
  'user-story': z.union([z.string(), z.array(z.string())]).optional(),
  enabler: z.union([z.string(), z.array(z.string())]).optional(),
}).partial();

const userTemplatesSchema = z.object({
  capability: z.string(),
  feature: z.string(),
  'user-story': z.string(),
  enabler: z.string(),
});

const typeInstructionsSchema = z.object({
  capability: z.string(),
  feature: z.string(),
  'user-story': z.string(),
  enabler: z.string(),
});

const storedSettingsSchema = z.object({
  id: z.literal('app'),
  instructions: z.string().default(''),
  templates: templatesSchema.default({}),
  principles: z.string().optional(),
  typeInstructions: typeInstructionsSchema.partial().default({}),
});

export type UserSettings = Omit<StoredAppSettings, 'id'>;

export const defaultUserSettings: UserSettings = {
  instructions: '',
  templates: defaultBacklogTemplates,
  principles: defaultPrinciples,
  typeInstructions: defaultTypeInstructions,
};

function normalizeTemplate(value: string | string[] | undefined, fallback: string): string {
  if (typeof value === 'string') return value.trim() ? convertPlaceholderTemplate(value) : fallback;
  if (!value) return fallback;
  return value.map((section) => `## ${section}`).join('\n\n');
}

export class SettingsRepository {
  constructor(private readonly db: BacklogDatabase = backlogDatabase) {}

  async load(): Promise<UserSettings> {
    const stored = await this.db.settings.get('app');
    if (!stored) return defaultUserSettings;

    const parsed = storedSettingsSchema.safeParse(stored);
    if (!parsed.success) {
      throw new Error(`Saved settings are invalid: ${parsed.error.message}`);
    }

    const migrated: UserSettings = {
      principles: defaultPrinciples,
      typeInstructions: defaultTypeInstructions,
      instructions: parsed.data.instructions,
      templates: {
        capability: normalizeTemplate(parsed.data.templates.capability, defaultBacklogTemplates.capability),
        feature: normalizeTemplate(parsed.data.templates.feature, defaultBacklogTemplates.feature),
        'user-story': normalizeTemplate(parsed.data.templates['user-story'], defaultBacklogTemplates['user-story']),
        enabler: normalizeTemplate(parsed.data.templates.enabler, defaultBacklogTemplates.enabler),
      },
    };
    const storedTypes = parsed.data.typeInstructions;
    migrated.principles = parsed.data.principles ?? defaultPrinciples;
    migrated.typeInstructions = {
      capability: storedTypes.capability ?? defaultTypeInstructions.capability,
      feature: storedTypes.feature ?? defaultTypeInstructions.feature,
      'user-story': storedTypes['user-story'] ?? defaultTypeInstructions['user-story'],
      enabler: storedTypes.enabler ?? defaultTypeInstructions.enabler,
    };
    const storedTemplates = parsed.data.templates as Record<string, unknown>;
    if (Object.entries(migrated.templates).some(([type, value]) => storedTemplates[type] !== undefined && storedTemplates[type] !== value)) {
      await this.save(migrated);
    }
    return migrated;
  }

  async save(settings: UserSettings): Promise<UserSettings> {
    const validated = z.object({
      instructions: z.string(),
      templates: userTemplatesSchema,
      principles: z.string(),
      typeInstructions: typeInstructionsSchema,
    }).parse(settings);
    const value: StoredAppSettings = {
      id: 'app',
      instructions: validated.instructions,
      templates: validated.templates,
      principles: validated.principles,
      typeInstructions: validated.typeInstructions,
    };
    await this.db.settings.put(value);
    return {
      instructions: value.instructions,
      templates: value.templates,
      principles: value.principles,
      typeInstructions: value.typeInstructions,
    };
  }

  async restoreDefaults(): Promise<UserSettings> {
    await this.db.settings.delete('app');
    return defaultUserSettings;
  }
}
