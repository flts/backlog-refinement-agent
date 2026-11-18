import { describe, expect, it } from 'vitest';
import * as document from './document';

interface DocumentFixture {
  name: string;
  description: string;
  fn: string;
  input: Record<string, unknown>;
  expected: unknown;
}

const files = import.meta.glob('../../../../contracts/fixtures/document/*.json', { eager: true, import: 'default' }) as Record<string, DocumentFixture>;
const fixtures = Object.values(files);

function run({ fn, input }: DocumentFixture): unknown {
  const i = input as never as Record<string, never>;
  switch (fn) {
    case 'applySectionUpdates': return document.applySectionUpdates(i.document, i.updates);
    case 'conformToTemplate': return document.conformToTemplate(i.template, i.markdown);
    case 'splitSections': return document.splitSections(i.document);
    case 'joinSections': return document.joinSections(input as never);
    case 'normalizeHeading': return document.normalizeHeading(i.heading);
    case 'diffDocuments': return document.diffDocuments(i.before, i.after);
    case 'parseChecklistSections': return document.parseChecklistSections(i.document);
    case 'updateChecklistLine': return document.updateChecklistLine(i.document, i.line as never, i.action);
    case 'templateHeadings': return document.templateHeadings(i.template);
    default: throw new Error(`Unknown fixture function ${fn}`);
  }
}

// Regenerate with `pnpm --filter @backlog/web fixtures:document`; the Python port asserts the same files.
describe('golden document fixtures (shared with backlog-api)', () => {
  it('exist for every merge function', () => {
    expect(new Set(fixtures.map((f) => f.fn))).toEqual(new Set([
      'applySectionUpdates', 'conformToTemplate', 'splitSections', 'joinSections', 'normalizeHeading',
      'diffDocuments', 'parseChecklistSections', 'updateChecklistLine', 'templateHeadings',
    ]));
  });

  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(run(fixture)).toEqual(fixture.expected);
  });
});
