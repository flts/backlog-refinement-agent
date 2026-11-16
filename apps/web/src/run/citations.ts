export interface Citation {
  /** Stable citation id `src:<sourceId>#<ordinal>`. */
  citationId: string;
  sourceId?: string;
  sourceName: string;
  page?: number | null;
  headingPath?: string | null;
  text: string;
}

export const SEARCH_SOURCES_TOOL_NAME = 'search_sources';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** MCP wraps results as `{content:[{type:'text',text:'<json>'}]}` (or `structuredContent` / `result`); unwrap until passages show up. */
function unwrap(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    return parsed === undefined ? value : unwrap(parsed, depth + 1);
  }
  if (Array.isArray(value) && value.length > 0 && value.every((part) => asRecord(part)?.type === 'text' && typeof asRecord(part)?.text === 'string')) {
    return unwrap((value as { text: string }[]).map((part) => part.text).join(''), depth + 1);
  }
  const record = asRecord(value);
  if (record && !('passages' in record)) {
    for (const key of ['structuredContent', 'result', 'content']) {
      if (record[key] !== undefined) return unwrap(record[key], depth + 1);
    }
  }
  return value;
}

/** Passages (with citation ids) of a `search_sources` tool result; `[]` for anything else. */
export function parseCitations(content: string): Citation[] {
  const value = unwrap(content);
  const list = Array.isArray(value) ? value : asRecord(value)?.passages;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const entry of list) {
    const passage = asRecord(entry);
    if (!passage || typeof passage.citationId !== 'string' || seen.has(passage.citationId)) continue;
    seen.add(passage.citationId);
    citations.push({
      citationId: passage.citationId,
      ...(typeof passage.sourceId === 'string' ? { sourceId: passage.sourceId } : {}),
      sourceName: typeof passage.sourceName === 'string' ? passage.sourceName : 'Source',
      ...(typeof passage.page === 'number' || passage.page === null ? { page: passage.page as number | null } : {}),
      ...(typeof passage.headingPath === 'string' || passage.headingPath === null ? { headingPath: passage.headingPath as string | null } : {}),
      text: typeof passage.text === 'string' ? passage.text : '',
    });
  }
  return citations;
}
