import { describe, expect, it } from 'vitest';
import { parseConfig, serializeConfig, markdownFilename } from './config-io';
import { defaultUserSettings } from '../infrastructure/storage/SettingsRepository';
import type { BacklogItem } from '../domain/backlog-item';

describe('config-io', () => {
  it('round-trips the current version', () => {
    expect(parseConfig(serializeConfig(defaultUserSettings))).toEqual(defaultUserSettings);
  });

  it.each([1, 2, 3])('rejects legacy version %s imports', (version) => {
    expect(() => parseConfig(JSON.stringify({ version, settings: {} }))).toThrow();
  });

  it('rejects a version 4 import with placeholder templates', () => {
    const settings = {
      ...defaultUserSettings,
      templates: { ...defaultUserSettings.templates, feature: '## Scope\n{{scope}}' },
    };
    expect(() => parseConfig(JSON.stringify({ version: 4, settings }))).toThrow(/placeholders/);
    expect(() => serializeConfig(settings)).toThrow(/placeholders/);
  });

  it('accepts a version 4 import with current settings', () => {
    expect(parseConfig(JSON.stringify({ version: 4, settings: defaultUserSettings })))
      .toEqual(defaultUserSettings);
  });

  it('rejects invalid input', () => {
    expect(() => parseConfig('{"version":9}')).toThrow();
  });

  it('builds a safe filename', () => {
    expect(markdownFilename({ title: ' Export: CSV & PDF! ' } as BacklogItem)).toBe('export-csv-pdf.md');
    expect(markdownFilename({ title: '???' } as BacklogItem)).toBe('backlog-item.md');
  });
});
