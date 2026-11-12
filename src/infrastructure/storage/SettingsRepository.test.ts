import { describe, expect, it, vi } from 'vitest';
import { defaultUserSettings, SettingsRepository } from './SettingsRepository';
import { BacklogDatabase } from './database';

function createRepository(stored?: unknown) {
  const settings = {
    get: vi.fn().mockResolvedValue(stored),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const repository = new SettingsRepository({ settings } as unknown as BacklogDatabase);
  return { repository, settings };
}

describe('SettingsRepository', () => {
  it('loads valid current-format settings without rewriting them', async () => {
    const stored = { id: 'app', ...defaultUserSettings };
    const { repository, settings } = createRepository(stored);

    await expect(repository.load()).resolves.toEqual(defaultUserSettings);
    expect(settings.put).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy template arrays', {
      ...defaultUserSettings,
      templates: { ...defaultUserSettings.templates, feature: ['## Scope'] },
    }],
    ['missing current settings', { instructions: '', templates: {} }],
    ['placeholder templates', {
      ...defaultUserSettings,
      templates: { ...defaultUserSettings.templates, feature: '## Scope\n{{scope}}' },
    }],
  ])('fails to load %s instead of migrating it', async (_label, settings) => {
    const { repository, settings: table } = createRepository({ id: 'app', ...settings });

    await expect(repository.load()).rejects.toThrow('Saved settings are invalid');
    expect(table.put).not.toHaveBeenCalled();
  });

  it('rejects placeholder templates when saving settings', async () => {
    const { repository, settings } = createRepository();
    const invalid = {
      ...defaultUserSettings,
      templates: { ...defaultUserSettings.templates, feature: '## Scope\n{{scope}}' },
    };

    await expect(repository.save(invalid)).rejects.toThrow(/placeholders/);
    expect(settings.put).not.toHaveBeenCalled();
  });
});
