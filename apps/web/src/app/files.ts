import type { Item } from '../api';

export function markdownFor(item: Pick<Item, 'title' | 'document'>): string {
  return `# ${item.title}\n\n${item.document}`.trim();
}

export function markdownFilename(item: Pick<Item, 'title'>): string {
  const slug = item.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'backlog-item';
  return `${slug}.md`;
}

export function downloadFile(filename: string, content: string | Blob, mime: string) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}
