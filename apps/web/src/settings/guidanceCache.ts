import type { QueryClient } from '@tanstack/react-query';
import { backlogKeys, type EffectiveGuidance, type GuidanceEntry, type GuidanceTarget } from '../api';

/** Shows a server-returned entry immediately instead of waiting for the refetch that follows every write. */
export function patchGuidanceEntry(queryClient: QueryClient, projectId: string, target: GuidanceTarget, entry: GuidanceEntry) {
  queryClient.setQueryData<EffectiveGuidance>(backlogKeys.guidance(projectId), (current) => {
    if (!current) return current;
    if (target.kind === 'principles') return { ...current, principles: entry };
    const field = target.kind === 'template' ? 'templates' : 'typeInstructions';
    return { ...current, [field]: { ...current[field], [target.itemType]: entry } };
  });
}

export function guidanceKey(target: GuidanceTarget): string {
  return target.kind === 'principles' ? 'principles' : `${target.kind}:${target.itemType}`;
}

export function entryFor(guidance: EffectiveGuidance, target: GuidanceTarget): GuidanceEntry | undefined {
  if (target.kind === 'principles') return guidance.principles;
  return (target.kind === 'template' ? guidance.templates : guidance.typeInstructions)[target.itemType];
}
