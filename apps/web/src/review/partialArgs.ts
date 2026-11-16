import { SectionChangeSchema, SuggestedStatusSchema, type DocumentPreview, type SectionChange } from '../contracts';

type Scan = { value: string; end: number } | null;

const whitespace = /\s/;

function skip(text: string, from: number): number {
  let i = from;
  while (i < text.length && whitespace.test(text[i])) i += 1;
  return i;
}

function readString(text: string, from: number): Scan {
  for (let j = from + 1; j < text.length; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === '"') {
      try {
        return { value: JSON.parse(text.slice(from, j + 1)) as string, end: j + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Index after the bracket pair that starts at `from` (strings respected), or null while it is still incomplete. */
function readBalanced(text: string, from: number): number | null {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      const string = readString(text, i);
      if (!string) return null;
      i = string.end - 1;
    } else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** Reads one JSON value without interpreting it; returns the index after it, or null when it is incomplete. */
function skipValue(text: string, from: number): number | null {
  const c = text[from];
  if (c === '"') return readString(text, from)?.end ?? null;
  if (c === '{' || c === '[') return readBalanced(text, from);
  let i = from;
  while (i < text.length && text[i] !== ',' && text[i] !== '}') i += 1;
  return i >= text.length ? null : i;
}

/**
 * Best-effort reader of the still-streaming arguments of `propose_document_changes` (spike #7: the server only
 * emits `preview` once the arguments are complete). Only COMPLETE values are returned: finished sections and finished
 * top-level scalars. Anything cut off is ignored, so a half-streamed section never reaches the preview.
 */
export function parsePartialProposal(text: string): DocumentPreview | null {
  let i = skip(text, 0);
  if (text[i] !== '{') return null;
  i += 1;
  const sections: SectionChange[] = [];
  const preview: Omit<DocumentPreview, 'sections'> = {};
  while (i < text.length) {
    i = skip(text, i);
    if (text[i] === ',') { i = skip(text, i + 1); }
    if (text[i] !== '"') break;
    const key = readString(text, i);
    if (!key) break;
    i = skip(text, key.end);
    if (text[i] !== ':') break;
    i = skip(text, i + 1);
    if (key.value === 'sections' && text[i] === '[') {
      i += 1;
      while (i < text.length) {
        i = skip(text, i);
        if (text[i] === ',') i = skip(text, i + 1);
        if (text[i] !== '{') break;
        const end = readBalanced(text, i);
        if (end === null) return finish(preview, sections);
        try {
          const parsed = SectionChangeSchema.safeParse(JSON.parse(text.slice(i, end)));
          if (parsed.success) sections.push(parsed.data);
        } catch { /* not valid JSON: skip */ }
        i = end;
      }
      if (text[i] === ']') { i += 1; continue; }
      break;
    }
    const end = skipValue(text, i);
    if (end === null) break;
    try {
      const value: unknown = JSON.parse(text.slice(i, end));
      if (key.value === 'summary' && typeof value === 'string') preview.summary = value;
      else if (key.value === 'suggestedTitle' && typeof value === 'string' && value) preview.suggestedTitle = value;
      else if (key.value === 'suggestedStatus') { const status = SuggestedStatusSchema.safeParse(value); if (status.success) preview.suggestedStatus = status.data; }
      else if ((key.value === 'baseVersion' || key.value === 'base_version') && typeof value === 'number') preview.baseVersion = value;
    } catch { /* incomplete scalar */ }
    i = end;
  }
  return finish(preview, sections);
}

function finish(preview: Omit<DocumentPreview, 'sections'>, sections: SectionChange[]): DocumentPreview | null {
  return sections.length > 0 || preview.summary ? { ...preview, sections } : null;
}
