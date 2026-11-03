export interface DocumentSection {
  heading: string;
  body: string;
}

export interface SplitDocument {
  preamble: string;
  sections: DocumentSection[];
}

export interface SectionUpdate {
  heading: string;
  markdown: string;
  mode: "replace" | "append";
}

export interface ApplyResult {
  document: string;
  warnings: string[];
}

export interface DocumentDiff {
  added: string[];
  removed: string[];
}

export type ChecklistKind = "assumption" | "question";

export interface ChecklistEntry {
  kind: ChecklistKind;
  text: string;
  checked: boolean;
  line: number;
}

const headingPattern = /^##\s+(.+?)\s*#*\s*$/;
const taskPattern = /^(\s*[-*]\s+)\[( |x|X)\]\s?(.*)$/;
const assumptionHeading = /assumption|aanname/i;
const questionHeading = /open\s+question|open\s+vra|openstaande\s+vra/i;

export const normalizeHeading = (heading: string): string =>
  heading.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").toLowerCase();

/** Level-2 headings split the document; deeper headings stay inside the section body. */
export function splitSections(document: string): SplitDocument {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = inFence ? null : headingPattern.exec(line);
    if (match) sections.push({ heading: match[1].trim(), lines: [] });
    else (sections.length ? sections[sections.length - 1].lines : preamble).push(line);
  }
  return {
    preamble: preamble.join("\n").trim(),
    sections: sections.map(({ heading, lines: body }) => ({ heading, body: body.join("\n").trim() })),
  };
}

export function joinSections({ preamble, sections }: SplitDocument): string {
  const parts = preamble ? [preamble] : [];
  for (const { heading, body } of sections) parts.push(body ? `## ${heading}\n${body}` : `## ${heading}`);
  return parts.join("\n\n").trim();
}

const meaningful = (line: string): string => line.trim();
const isChecked = (line: string): boolean => {
  const match = taskPattern.exec(line);
  return match !== null && match[2].toLowerCase() === "x";
};

/**
 * Merge section-level updates into an existing document. Sections that are not mentioned
 * are left untouched, and confirmed (`[x]`) lines are never dropped by a replacement.
 */
export function applySectionUpdates(document: string, updates: readonly SectionUpdate[]): ApplyResult {
  const split = splitSections(document);
  const sections = split.sections.map((section) => ({ ...section }));
  const warnings: string[] = [];
  for (const update of updates) {
    const key = normalizeHeading(update.heading);
    const incoming = update.markdown.trim();
    const existing = sections.find((section) => normalizeHeading(section.heading) === key);
    if (!existing) {
      sections.push({ heading: update.heading.trim(), body: incoming });
      continue;
    }
    if (update.mode === "append") {
      const known = new Set(existing.body.split("\n").map(meaningful));
      const fresh = incoming.split("\n").filter((line) => !line.trim() || !known.has(meaningful(line)));
      const addition = fresh.join("\n").trim();
      if (addition) existing.body = existing.body ? `${existing.body}\n${addition}` : addition;
      continue;
    }
    const incomingLines = new Set(incoming.split("\n").map(meaningful));
    const kept = existing.body.split("\n").filter((line) => isChecked(line) && !incomingLines.has(meaningful(line)));
    if (kept.length) {
      warnings.push(`"${existing.heading}": ${kept.length} confirmed item(s) were kept instead of removed.`);
      existing.body = `${incoming}\n${kept.join("\n")}`.trim();
    } else {
      existing.body = incoming;
    }
  }
  return { document: joinSections({ preamble: split.preamble, sections }), warnings };
}

/** Line-based diff (longest common subsequence); documents are small. */
export function diffDocuments(before: string, after: string): DocumentDiff {
  const a = before.split("\n").map(meaningful).filter(Boolean);
  const b = after.split("\n").map(meaningful).filter(Boolean);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return { added, removed };
}

export function parseChecklistSections(document: string): ChecklistEntry[] {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  const entries: ChecklistEntry[] = [];
  let kind: ChecklistKind | undefined;
  lines.forEach((line, index) => {
    const heading = headingPattern.exec(line);
    if (heading) {
      kind = questionHeading.test(heading[1]) ? "question" : assumptionHeading.test(heading[1]) ? "assumption" : undefined;
      return;
    }
    const task = kind ? taskPattern.exec(line) : null;
    if (kind && task && task[3].trim()) {
      entries.push({ kind, text: task[3].trim(), checked: task[2].toLowerCase() === "x", line: index });
    }
  });
  return entries;
}

/** Confirm/resolve a checklist line or remove it; returns the document unchanged for a stale line. */
export function updateChecklistLine(document: string, line: number, action: "check" | "remove"): string {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  const task = taskPattern.exec(lines[line] ?? "");
  if (!task) return document;
  if (action === "remove") lines.splice(line, 1);
  else lines[line] = `${task[1]}[x] ${task[3]}`;
  return lines.join("\n");
}

/** Fold structured data of the former model into one Markdown document. */
export function legacyFieldsToDocument(item: {
  description?: string;
  contextValues?: readonly { key: string; value: string }[];
  assumptions?: readonly { text: string; confirmed?: boolean }[];
  openQuestions?: readonly { text: string; status?: string }[];
}): string {
  const parts: string[] = [];
  if (item.description?.trim()) parts.push(item.description.trim());
  for (const { key, value } of item.contextValues ?? []) if (value.trim()) parts.push(`## ${key}\n${value.trim()}`);
  if (item.assumptions?.length) {
    parts.push(`## Assumptions\n${item.assumptions.map(({ text, confirmed }) => `- [${confirmed ? "x" : " "}] ${text}`).join("\n")}`);
  }
  if (item.openQuestions?.length) {
    parts.push(`## Open questions\n${item.openQuestions.map(({ text, status }) => `- [${status === "answered" ? "x" : " "}] ${text}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Convert a template that uses `{{…}}` placeholders into a plain Markdown template. */
export function convertPlaceholderTemplate(template: string): string {
  if (!/\{\{[^}]+}}/.test(template)) return template;
  const converted = template
    .replace(/^#\s*\{\{title}}\s*$/gm, "# Title")
    .replace(/^\s*\{\{(?:field:[^}]*|[a-zA-Z]+)}}\s*$/gm, "")
    .replace(/\{\{[^}]+}}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return converted.replace(/^(##\s+(?:.*(?:assumption|aanname).*|.*open\s+question.*))$/gim, "$1\n- [ ] ");
}

const stripHints = (markdown: string): string => markdown.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Rebuild a document on the headings of a template: filled sections are kept, missing ones stay
 * empty, hints are removed and sections the template does not know are kept under "Additional notes".
 */
export function conformToTemplate(template: string, markdown: string): { document: string; extraHeadings: string[] } {
  const wanted = splitSections(stripHints(template));
  if (!wanted.sections.length) return { document: markdown.trim(), extraHeadings: [] };
  const given = splitSections(markdown);
  const used = new Set<number>();
  const sections = wanted.sections.map(({ heading }) => {
    const index = given.sections.findIndex((section, i) =>
      !used.has(i) && normalizeHeading(section.heading) === normalizeHeading(heading));
    if (index < 0) return { heading, body: "" };
    used.add(index);
    return { heading, body: given.sections[index].body };
  });
  const extra = given.sections.filter((_, i) => !used.has(i));
  const notes = [given.preamble, ...extra.map(({ heading, body }) => `### ${heading}\n${body}`.trim())]
    .filter(Boolean).join("\n\n");
  if (notes) sections.push({ heading: "Additional notes", body: notes });
  return {
    document: joinSections({ preamble: "", sections }),
    extraHeadings: extra.map(({ heading }) => heading),
  };
}
