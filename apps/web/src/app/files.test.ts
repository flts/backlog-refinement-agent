import { describe, expect, it } from 'vitest';
import { markdownFilename, markdownFor } from './files';

describe('files', () => {
  it('builds a safe filename', () => {
    expect(markdownFilename({ title: ' Export: CSV & PDF! ' })).toBe('export-csv-pdf.md');
    expect(markdownFilename({ title: '???' })).toBe('backlog-item.md');
  });

  it('renders an item as Markdown', () => {
    expect(markdownFor({ title: 'Export', document: '## Goal\nShip' })).toBe('# Export\n\n## Goal\nShip');
  });
});
