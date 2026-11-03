import { describe, expect, it } from 'vitest';
import { parseConfig, serializeConfig, markdownFilename } from './config-io';
import { defaultUserSettings } from '../infrastructure/storage/SettingsRepository';
import { defaultPrinciples } from '../defaults/instructions';
import type { BacklogItem } from '../domain/backlog-item';

describe('config-io', () => {
  it('round-trips the current version', () => {
    expect(parseConfig(serializeConfig(defaultUserSettings))).toEqual(defaultUserSettings);
  });

  it('upgrades a v1 config with section lists to Markdown headings and default principles', () => {
    const v1 = { version: 1, settings: { templates: { capability: ['Goal', 'Scope'], feature: [], 'user-story': [], enabler: [] } } };
    const result = parseConfig(JSON.stringify(v1));
    expect(result.templates.capability).toBe('## Goal\n\n## Scope');
    expect(result.templates.feature).toBe(defaultUserSettings.templates.feature);
    expect(result.principles).toBe(defaultPrinciples);
  });

  it('rejects invalid input', () => {
    expect(() => parseConfig('{"version":9}')).toThrow();
  });

  it('builds a safe filename', () => {
    expect(markdownFilename({ title: ' Export: CSV & PDF! ' } as BacklogItem)).toBe('export-csv-pdf.md');
    expect(markdownFilename({ title: '???' } as BacklogItem)).toBe('backlog-item.md');
  });
});
