export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };
export type DiffRow = DiffLine | { kind: 'skip'; count: number };

const maxCells = 4_000_000;

/** Ordered line diff (longest common subsequence). Very large inputs degrade to "everything removed, everything added". */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > maxCells) return [...a.map((text): DiffLine => ({ kind: 'remove', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))];
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) lines.push({ kind: 'remove', text: a[i++] });
    else lines.push({ kind: 'add', text: b[j++] });
  }
  while (i < a.length) lines.push({ kind: 'remove', text: a[i++] });
  while (j < b.length) lines.push({ kind: 'add', text: b[j++] });
  return lines;
}

/** Collapses long runs of unchanged lines, keeping `context` lines around every change. */
export function collapseUnchanged(lines: DiffLine[], context = 2): DiffRow[] {
  const keep = lines.map((line) => line.kind !== 'same');
  const near = keep.map((_, index) => { for (let d = -context; d <= context; d += 1) if (keep[index + d]) return true; return false; });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (near[index]) {
      if (skipped) { rows.push({ kind: 'skip', count: skipped }); skipped = 0; }
      rows.push(line);
    } else skipped += 1;
  });
  if (skipped) rows.push({ kind: 'skip', count: skipped });
  return rows;
}

export const hasChanges = (lines: DiffLine[]) => lines.some((line) => line.kind !== 'same');
