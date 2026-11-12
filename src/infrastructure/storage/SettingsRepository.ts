import { z } from 'zod';
import { defaultBacklogTemplates } from '../../defaults/templates';
import { defaultPrinciples, defaultTypeInstructions } from '../../defaults/instructions';
import { BacklogDatabase, backlogDatabase, type StoredAppSettings } from './database';

const typeMapSchema = z.object({
  capability: z.string(),
  feature: z.string(),
  'user-story': z.string(),
  enabler: z.string(),
}).strict();
const templateSchema = z.string().refine((value) => !value.includes('{{'), {
  message: 'Templates must not contain placeholders',
});
const templatesSchema = z.object({
  capability: templateSchema,
  feature: templateSchema,
  'user-story': templateSchema,
  enabler: templateSchema,
}).strict();
const userSettingsSchema = z.object({
  instructions: z.string(),
  templates: templatesSchema,
  principles: z.string(),
  typeInstructions: typeMapSchema,
}).strict();
const storedSettingsSchema = userSettingsSchema.extend({ id: z.literal('app') }).strict();

export type UserSettings = Omit<StoredAppSettings, 'id'>;

export const defaultUserSettings: UserSettings = {
  instructions: '',
  templates: defaultBacklogTemplates,
  principles: defaultPrinciples,
  typeInstructions: defaultTypeInstructions,
};

export class SettingsRepository {
  constructor(private readonly db: BacklogDatabase = backlogDatabase) {}

  async load(): Promise<UserSettings> {
    const stored = await this.db.settings.get('app');
    if (!stored) return defaultUserSettings;

    const parsed = storedSettingsSchema.safeParse(stored);
    if (!parsed.success) {
      throw new Error(`Saved settings are invalid: ${parsed.error.message}`);
    }

    const { id: _id, ...settings } = parsed.data;
    return settings;
  }

  async save(settings: UserSettings): Promise<UserSettings> {
    const validated = userSettingsSchema.parse(settings);
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
