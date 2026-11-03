import { describe, expect, it } from 'vitest';
import { defaultBacklogTemplates } from './templates';

describe('source backlog templates', () => {
  it('loads a complete Markdown template for every backlog type', () => {
    expect(Object.keys(defaultBacklogTemplates)).toEqual([
      'capability',
      'feature',
      'user-story',
      'enabler',
    ]);
    for (const template of Object.values(defaultBacklogTemplates)) {
      expect(template).toMatch(/^# \{\{title}}/);
      expect(template).toContain('{{assumptions}}');
      expect(template).toContain('{{openQuestions}}');
    }
  });
});
