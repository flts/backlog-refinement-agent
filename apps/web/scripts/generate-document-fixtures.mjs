// Regenerates contracts/fixtures/document/*.json from the CURRENT apps/web/src/domain/document.ts.
// Run: pnpm --filter @backlog/web fixtures:document   (Node >= 22.18 strips the TypeScript types natively.)
// The fixtures are the golden source for the Python port in backlog-api; document.fixtures.test.ts asserts them.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as document from '../src/domain/document.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/fixtures/document');

const doc = '## Summary\nOld\n\n## Assumptions\n- [x] Kept\n- [ ] Maybe\n\n## Open questions\n- [ ] Who?';
const template = '# T\n\n## Summary\n<!-- hint -->\n\n## Scope\n<!-- hint -->\n\n## Assumptions\n- [ ] \n\n## Open questions\n- [ ] ';
const upd = (heading, markdown, mode = 'replace') => ({ heading, markdown, mode });

const cases = [
  // applySectionUpdates
  ['apply-replace-section', 'Replace swaps only the named section and leaves the others untouched.', 'applySectionUpdates',
    { document: doc, updates: [upd('Summary', 'New')] }],
  ['apply-replace-heading-normalisation', 'Heading matching ignores case, surrounding and repeated whitespace.', 'applySectionUpdates',
    { document: doc, updates: [upd('  SUMMARY ', 'New')] }],
  ['apply-replace-keeps-checked-lines', 'A replacement never drops confirmed "- [x]" lines; a warning is returned.', 'applySectionUpdates',
    { document: doc, updates: [upd('Assumptions', '- [ ] Other')] }],
  ['apply-replace-keeps-checked-lines-already-present', 'Confirmed lines that the replacement repeats are not duplicated and cause no warning.', 'applySectionUpdates',
    { document: doc, updates: [upd('Assumptions', '- [x] Kept\n- [ ] Other')] }],
  ['apply-replace-uppercase-x', 'An uppercase "[X]" counts as confirmed.', 'applySectionUpdates',
    { document: '## A\n- [X] Done\n- [ ] Todo', updates: [upd('A', 'fresh')] }],
  ['apply-append-section', 'Append adds only lines that are not yet present.', 'applySectionUpdates',
    { document: doc, updates: [upd('Open questions', '- [ ] Who?\n- [ ] When?', 'append')] }],
  ['apply-append-to-empty-section', 'Append to an empty section sets its body.', 'applySectionUpdates',
    { document: '## A\n\n## B\ntext', updates: [upd('A', 'first', 'append')] }],
  ['apply-append-nothing-new', 'Append with only known lines leaves the document unchanged.', 'applySectionUpdates',
    { document: doc, updates: [upd('Summary', 'Old', 'append')] }],
  ['apply-unknown-heading-adds-section', 'An unknown heading is appended as a new section at the end (trimmed heading).', 'applySectionUpdates',
    { document: doc, updates: [upd('  Risks ', 'None')] }],
  ['apply-unknown-heading-append-mode', 'Append mode on an unknown heading also creates the section.', 'applySectionUpdates',
    { document: doc, updates: [upd('Risks', 'None', 'append')] }],
  ['apply-multiple-updates-in-order', 'Several updates are applied in order, including one that targets a section created earlier.', 'applySectionUpdates',
    { document: doc, updates: [upd('Risks', 'One'), upd('risks', 'Two', 'append'), upd('Summary', 'New')] }],
  ['apply-preamble-preserved', 'Text before the first level-2 heading (title, intro) is kept as preamble.', 'applySectionUpdates',
    { document: '# Title\n\nIntro text.\n\n## Summary\nOld', updates: [upd('Summary', 'New')] }],
  ['apply-subheadings-stay-in-section', 'Level-3 headings stay inside their level-2 section body.', 'applySectionUpdates',
    { document: '## A\n### Sub\ntext\n\n## B\nb', updates: [upd('B', 'new b')] }],
  ['apply-heading-in-code-fence-ignored', 'A "## " line inside a fenced code block does not start a section.', 'applySectionUpdates',
    { document: '## A\n```\n## not a heading\n```\n\n## B\nb', updates: [upd('B', 'x')] }],
  ['apply-crlf-normalised', 'CRLF line endings are normalised to LF.', 'applySectionUpdates',
    { document: '## A\r\nline\r\n\r\n## B\r\nb', updates: [upd('A', 'x')] }],
  ['apply-empty-document', 'Updates on an empty document create the sections.', 'applySectionUpdates',
    { document: '', updates: [upd('Summary', 'First'), upd('Scope', 'Second')] }],
  ['apply-no-updates-normalises', 'Without updates the document is re-joined (blank lines normalised, trimmed).', 'applySectionUpdates',
    { document: '\n## A\n\n\nbody  \n\n\n## B\n', updates: [] }],
  ['apply-empty-markdown-clears-section', 'Replacing with an empty body leaves just the heading.', 'applySectionUpdates',
    { document: '## A\nx\n\n## B\ny', updates: [upd('A', '   ')] }],
  ['apply-closing-hashes-in-heading', 'Trailing "#" characters of a heading are not part of its name.', 'applySectionUpdates',
    { document: '## Summary ##\nOld', updates: [upd('Summary', 'New')] }],
  ['apply-unicode-heading', 'Non-ASCII headings match case-insensitively.', 'applySectionUpdates',
    { document: '## Öffnungszeiten\nalt', updates: [upd('öffnungszeiten', 'neu')] }],

  // conformToTemplate
  ['conform-extra-headings', 'Filled sections are kept, missing ones stay empty, hints are removed and unknown sections move under "Additional notes".', 'conformToTemplate',
    { template, markdown: '## assumptions\n- [ ] A\n\n## Summary\nS\n\n## My own\nExtra' }],
  ['conform-merges-renamed-lists', 'Renamed assumption/question sections are merged into the template lists.', 'conformToTemplate',
    { template: '## Summary\n\n## Assumptions\n- [ ] \n\n## Open questions\n- [ ] ', markdown: '## Summary\nS\n\n## Aannames\n- [ ] A1\n\n## Open vragen\n- [ ] Q1' }],
  ['conform-prefix-heading-match', 'A heading that is a prefix of the template heading (longer than 3 characters) matches it.', 'conformToTemplate',
    { template: '## Acceptance criteria\n\n## Scope', markdown: '## Acceptance\n- [ ] Works' }],
  ['conform-preamble-to-notes', 'Preamble text of the given document ends up in "Additional notes".', 'conformToTemplate',
    { template: '## Summary\n\n## Scope', markdown: 'Loose intro\n\n## Summary\nS' }],
  ['conform-template-without-sections', 'A template without level-2 sections returns the trimmed markdown.', 'conformToTemplate',
    { template: '# Just a title', markdown: '  anything\n## goes  ' }],
  ['conform-empty-document', 'An empty document yields the empty template structure.', 'conformToTemplate',
    { template, markdown: '' }],
  ['conform-duplicate-headings-used-once', 'Two given sections with the same heading: the first fills the template, the second becomes an additional note.', 'conformToTemplate',
    { template: '## Summary\n\n## Scope', markdown: '## Summary\nfirst\n\n## Summary\nsecond' }],

  // splitSections / joinSections / normalizeHeading
  ['split-basic', 'Splits into preamble and level-2 sections with trimmed bodies.', 'splitSections',
    { document: '# T\n\n## A\n a \n\n### Sub\nx\n\n## B\n' }],
  ['split-empty', 'An empty document has no preamble and no sections.', 'splitSections', { document: '' }],
  ['split-fence-and-crlf', 'Fenced headings are ignored and CRLF is normalised.', 'splitSections',
    { document: '## A\r\n```md\r\n## fake\r\n```\r\n## B' }],
  ['join-basic', 'Joins preamble and sections with blank lines; empty bodies produce a bare heading.', 'joinSections',
    { preamble: 'Intro', sections: [{ heading: 'A', body: 'a' }, { heading: 'B', body: '' }] }],
  ['join-empty', 'Nothing to join gives an empty string.', 'joinSections', { preamble: '', sections: [] }],
  ['normalize-heading-spaces-and-case', 'Trims, collapses whitespace and lower-cases.', 'normalizeHeading', { heading: '  Open   QUESTIONS ' }],
  ['normalize-heading-hashes', 'A leading run of "#" is stripped.', 'normalizeHeading', { heading: '## Summary' }],

  // diffDocuments
  ['diff-line-changes', 'Line-based diff on trimmed, non-empty lines.', 'diffDocuments', { before: 'a\nb\nc', after: 'a\nx\nc\nd' }],
  ['diff-whitespace-and-blank-lines-ignored', 'Indentation and blank lines do not count as changes.', 'diffDocuments', { before: 'a\n\n  b  ', after: 'a\nb' }],
  ['diff-identical', 'Identical documents have no added or removed lines.', 'diffDocuments', { before: '## A\nx', after: '## A\nx' }],
  ['diff-empty-before', 'Everything is added when the before document is empty.', 'diffDocuments', { before: '', after: '## A\nx' }],
  ['diff-reordered', 'A moved line is reported as removed and added.', 'diffDocuments', { before: 'a\nb\nc', after: 'b\nc\na' }],

  // checklist
  ['checklist-parse', 'Only task lines under assumption/question headings are returned, with their zero-based line numbers.', 'parseChecklistSections',
    { document: doc }],
  ['checklist-parse-localised-headings', 'Dutch/Afrikaans headings are recognised; empty items and other sections are skipped.', 'parseChecklistSections',
    { document: '## Aannames\n- [ ] A\n* [x] B\n- [ ] \n\n## Openstaande vragen\n- [ ] Q\n\n## Scope\n- [ ] not a checklist entry' }],
  ['checklist-parse-empty', 'No checklist sections gives an empty list.', 'parseChecklistSections', { document: '## Summary\n- [ ] x' }],
  ['checklist-update-check', 'Checking a line turns "[ ]" into "[x]".', 'updateChecklistLine', { document: doc, line: 5, action: 'check' }],
  ['checklist-update-remove', 'Removing a line deletes it.', 'updateChecklistLine', { document: doc, line: 5, action: 'remove' }],
  ['checklist-update-stale-line', 'A line that is not a task leaves the document unchanged.', 'updateChecklistLine', { document: doc, line: 0, action: 'check' }],
  ['checklist-update-out-of-range', 'A line past the end leaves the document unchanged.', 'updateChecklistLine', { document: doc, line: 99, action: 'remove' }],
  ['checklist-update-keeps-indent-and-bullet', 'Indentation and the bullet character are preserved when checking.', 'updateChecklistLine',
    { document: '## Assumptions\n  * [ ] Nested', line: 1, action: 'check' }],

  // template headings
  ['template-headings', 'Headings of a template, with hints stripped.', 'templateHeadings', { template }],
];

const run = (fn, input) => {
  switch (fn) {
    case 'applySectionUpdates': return document.applySectionUpdates(input.document, input.updates);
    case 'conformToTemplate': return document.conformToTemplate(input.template, input.markdown);
    case 'splitSections': return document.splitSections(input.document);
    case 'joinSections': return document.joinSections(input);
    case 'normalizeHeading': return document.normalizeHeading(input.heading);
    case 'diffDocuments': return document.diffDocuments(input.before, input.after);
    case 'parseChecklistSections': return document.parseChecklistSections(input.document);
    case 'updateChecklistLine': return document.updateChecklistLine(input.document, input.line, input.action);
    case 'templateHeadings': return document.templateHeadings(input.template);
    default: throw new Error(`Unknown fn ${fn}`);
  }
};

mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir)) if (file.endsWith('.json')) rmSync(join(outDir, file));
for (const [name, description, fn, input] of cases) {
  const fixture = { name, description, fn, input, expected: run(fn, input) };
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}
console.log(`Wrote ${cases.length} fixtures to ${outDir}`);
