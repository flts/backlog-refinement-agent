export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'txt', 'md', 'markdown', 'csv', 'json'] as const;
export const FILE_ACCEPT = '.pdf,.txt,.md,.markdown,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json';

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Client-side pre-check (the server validates again, by magic bytes); returns a user-facing message or `undefined`. */
export function checkUploadFile(file: Pick<File, 'name' | 'size'>): string | undefined {
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) return `“${file.name}” was not added: only PDF, TXT, MD, CSV and JSON files are supported.`;
  if (file.size > MAX_UPLOAD_BYTES) return `“${file.name}” was not added: it is ${formatMiB(file.size)} and the limit is ${formatMiB(MAX_UPLOAD_BYTES)}.`;
  if (file.size === 0) return `“${file.name}” was not added: the file is empty.`;
  return undefined;
}
