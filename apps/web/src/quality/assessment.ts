import { z } from 'zod';
import type { Item } from '../api';
import type { StateQuality } from '../contracts';
import { QualityAssessmentSchema } from '../domain/backlog-item';
import { itemTypeLabel } from '../app/labels';

const AssessmentSchema = QualityAssessmentSchema.extend({ summary: z.string().optional() });
export type Assessment = z.infer<typeof AssessmentSchema>;

export type Overall = Assessment['overall'];
export type Level = Assessment['areas'][number]['level'];

/** An assessment ready for display, whichever source it came from. */
export interface ShownAssessment {
  assessment: Assessment;
  assessedAt?: string;
  /** The document changed after the assessment was made. */
  stale: boolean;
}

/** The server stores assessments as JSON; absent optional fields may be `null`. */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null).map(([key, entry]) => [key, stripNulls(entry)]));
  return value;
}

export const overallText: Record<Overall, string> = {
  ready: 'Ready',
  'ready-with-open-questions': 'Ready with open questions',
  'needs-clarification': 'Needs clarification',
};

export const levelText: Record<Level, string> = { clear: 'Clear', unclear: 'Unclear', missing: 'Missing', 'not-applicable': 'Not applicable' };

export const areaText = (area: string) => area.replaceAll('-', ' ');

/** Flags and suggestions of an assessment as plain sentences. */
export function qualityDiagnostics(quality: Assessment): string[] {
  return [
    quality.excessiveTechnicalDetail && 'Contains excessive technical detail',
    quality.speculativeScope && 'Contains speculative scope',
    quality.unnecessaryConfigurability && 'Contains unnecessary configurability',
    quality.mixedOutcomes && 'Mixes multiple outcomes',
    quality.suggestedItemType && `Better suited as: ${itemTypeLabel[quality.suggestedItemType]}`,
    ...(quality.suggestedSplit ?? []).map((part) => `Suggested split: ${part}`),
    ...(quality.excludedFollowUpCandidates ?? []).map((part) => `Follow-up candidate: ${part}`),
  ].filter((entry): entry is string => Boolean(entry));
}

/**
 * Picks what the Quality tab shows: the stored assessment of the item, unless the agent state carries a newer one
 * (an assess run that just finished, before the item query refetched). Staleness compares the assessed hash with the item's.
 */
export function pickAssessment(item: Pick<Item, 'documentHash' | 'quality'>, live?: StateQuality | null): ShownAssessment | undefined {
  const stored = item.quality;
  const storedParsed = stored ? AssessmentSchema.safeParse(stripNulls(stored.assessment)) : undefined;
  const storedShown: ShownAssessment | undefined = stored && storedParsed?.success
    ? { assessment: storedParsed.data, assessedAt: stored.assessedAt ?? undefined, stale: stored.stale || Boolean(stored.documentHash && stored.documentHash !== item.documentHash) }
    : undefined;
  const liveParsed = live ? AssessmentSchema.safeParse(stripNulls(live)) : undefined;
  const liveShown: ShownAssessment | undefined = live && liveParsed?.success
    ? { assessment: liveParsed.data, assessedAt: live.assessedAt, stale: Boolean(live.documentHash && live.documentHash !== item.documentHash) }
    : undefined;
  if (!liveShown) return storedShown;
  if (!storedShown) return liveShown;
  return liveShown.assessedAt && storedShown.assessedAt && liveShown.assessedAt > storedShown.assessedAt ? liveShown : storedShown;
}
