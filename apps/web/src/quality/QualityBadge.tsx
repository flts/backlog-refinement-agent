import type { ItemSummary } from '../api';

const labels = {
  stale: { glyph: '⟳', text: 'Quality assessment is stale' },
  'needs-clarification': { glyph: '!', text: 'Needs clarification' },
  ready: { glyph: '✓', text: 'Quality: ready' },
  'ready-with-open-questions': { glyph: '◐', text: 'Quality: ready with open questions' },
} as const;

/** Tree-row marker for an item's latest quality assessment; renders nothing when it was never assessed. */
export function QualityBadge({ quality }: { quality?: ItemSummary['quality'] }) {
  if (!quality?.overall && !quality?.assessedAt) return null;
  const key = quality.stale ? 'stale' : quality.overall;
  if (!key) return null;
  const { glyph, text } = labels[key];
  return <span className={`quality-badge quality-badge-${key}`} title={text}><span aria-hidden="true">{glyph}</span><span className="sr-only">{text}</span></span>;
}
