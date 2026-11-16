export const layoutStorageKey = 'layout-widths';
export const resizeStep = 16;
export const splitterWidth = 10;
/** Narrowest the chat column may get while the side panels are resized. */
export const chatMinWidth = 360;

export type PanelId = 'tree' | 'doc';
export type FocusTarget = 'chat' | 'document';
export interface Widths { tree: number; doc: number }

export const bounds: Record<PanelId, { min: number; max: number; initial: number }> = {
  tree: { min: 200, max: 480, initial: 260 },
  doc: { min: 320, max: 820, initial: 420 },
};

export const defaultWidths: Widths = { tree: bounds.tree.initial, doc: bounds.doc.initial };

/**
 * The widest `panel` may be right now. `containerWidth` is the workspace width; 0 or unknown means "not measured", which
 * leaves only the static maximum so layout never depends on measurements in environments without layout.
 */
export function maxFor(panel: PanelId, widths: Widths, containerWidth: number): number {
  const { min, max } = bounds[panel];
  if (!containerWidth) return max;
  const other = panel === 'tree' ? widths.doc : widths.tree;
  const room = containerWidth - other - chatMinWidth - 2 * splitterWidth;
  return Math.max(min, Math.min(max, room));
}

export const clampWidth = (panel: PanelId, value: number, widths: Widths, containerWidth: number) =>
  Math.round(Math.min(maxFor(panel, widths, containerWidth), Math.max(bounds[panel].min, value)));

/** Widths that fit the container: the document panel gives way first, then the tree. */
export function fitWidths(widths: Widths, containerWidth: number): Widths {
  const doc = clampWidth('doc', widths.doc, widths, containerWidth);
  const tree = clampWidth('tree', widths.tree, { ...widths, doc }, containerWidth);
  return { tree, doc };
}

export function loadWidths(): Widths {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(layoutStorageKey) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      const { tree, doc } = parsed as Record<string, unknown>;
      if (typeof tree === 'number' && typeof doc === 'number' && Number.isFinite(tree) && Number.isFinite(doc)) {
        return {
          tree: Math.min(bounds.tree.max, Math.max(bounds.tree.min, Math.round(tree))),
          doc: Math.min(bounds.doc.max, Math.max(bounds.doc.min, Math.round(doc))),
        };
      }
    }
  } catch { /* unreadable storage or JSON: use defaults */ }
  return defaultWidths;
}

export function saveWidths(widths: Widths) {
  try { localStorage.setItem(layoutStorageKey, JSON.stringify(widths)); } catch { /* storage unavailable: widths last for this visit only */ }
}
