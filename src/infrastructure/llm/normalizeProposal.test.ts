import { describe, expect, it } from 'vitest';
import { RefinementProposalSchema } from '../../domain/proposal';
import { normalizeProposal } from './normalizeProposal';

describe('normalizeProposal', () => {
  it('coerces question importance and generates missing ids', () => {
    const parsed = RefinementProposalSchema.parse(normalizeProposal({
      id: 'a', kind: 'assessment', itemId: 'i', generatedAt: '2026-11-03T00:00:00.000Z', summary: 's',
      questions: [{ text: 'What?', importance: 'high' }],
    }));
    expect(parsed.kind === 'assessment' && parsed.questions[0]).toMatchObject({ importance: 'important' });
    expect(parsed.kind === 'assessment' && parsed.questions[0].id).toMatch(/^question-/);
  });

  it('converts a full suggestedDescription into per-section replace updates', () => {
    const parsed = RefinementProposalSchema.parse(normalizeProposal({
      id: 'a', kind: 'assessment', itemId: 'i', generatedAt: '2026-11-03T00:00:00.000Z', summary: 's',
      suggestedDescription: '## Summary\nHello\n\n## Scope\nSmall',
      contextValues: [{ key: 'x' }],
    }));
    expect(parsed.kind === 'assessment' && parsed.sectionUpdates).toEqual([
      { heading: 'Summary', markdown: 'Hello', mode: 'replace' },
      { heading: 'Scope', markdown: 'Small', mode: 'replace' },
    ]);
  });

  it('maps relationship endpoint aliases', () => {
    const parsed = RefinementProposalSchema.parse(normalizeProposal({
      id: 'd', kind: 'decomposition', parentItemId: 'p', generatedAt: '2026-11-03T00:00:00.000Z', rationale: 'r',
      children: [{ proposalId: 'a', type: 'feature', title: 'A' }, { proposalId: 'b', type: 'feature', title: 'B' }],
      relationships: [{ type: 'depends-on', fromProposalId: 'b', toProposalId: 'a', rationale: 'x' }],
    }));
    expect(parsed.kind === 'decomposition' && parsed.relationships[0]).toEqual({ type: 'depends-on', sourceRef: 'b', targetRef: 'a' });
  });

  it('keeps recognised quality areas and diagnostics and drops unknown ones', () => {
    const parsed = RefinementProposalSchema.parse(normalizeProposal({
      id: 'a', kind: 'assessment', itemId: 'i', generatedAt: '2026-11-03T00:00:00.000Z', summary: 's',
      quality: {
        overall: 'needs-clarification',
        areas: [{ area: 'lean_scope', level: 'unclear' }, { area: 'made-up', level: 'clear' }],
        mixedOutcomes: true, speculativeScope: 'yes', suggestedItemType: 'enabler', suggestedSplit: ['store', 'find'],
      },
    }));
    const quality = parsed.kind === 'assessment' ? parsed.quality : undefined;
    expect(quality?.areas).toEqual([{ area: 'lean-scope', level: 'unclear' }]);
    expect(quality).toMatchObject({ mixedOutcomes: true, suggestedItemType: 'enabler', suggestedSplit: ['store', 'find'] });
    expect(quality?.speculativeScope).toBeUndefined();
  });

  it('builds a child description from template sections', () => {
    const parsed = normalizeProposal({
      kind: 'decomposition', parentItemId: 'p', rationale: 'r',
      children: [{ type: 'feature', title: 'T', sections: [{ heading: '## Summary', markdown: 'S' }, { heading: 'Scope', markdown: ['a', 'b'] }] }],
    }) as { children: { description: string }[] };
    expect(parsed.children[0].description).toBe('## Summary\nS\n\n## Scope\na\nb');
  });
});
