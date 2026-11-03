import { describe, expect, it } from 'vitest';
import { RefinementProposalSchema } from '../../domain/proposal';
import { normalizeProposal } from './normalizeProposal';

describe('normalizeProposal', () => {
  it('coerces near-miss enum values and string provenance so the proposal validates', () => {
    const parsed = RefinementProposalSchema.parse(normalizeProposal({
      id: 'a', kind: 'assessment', itemId: 'i', generatedAt: '2026-11-03T00:00:00.000Z', summary: 's',
      questions: [{ id: 'q', text: 'What?', importance: 'high' }],
      contextValues: [{ key: 'Title', value: 'test', knowledgeStatus: 'provided', provenance: 'conversation:123' }],
    }));
    expect(parsed.kind === 'assessment' && parsed.questions[0].importance).toBe('important');
    expect(parsed.kind === 'assessment' && parsed.contextValues[0]).toMatchObject({
      knowledgeStatus: 'known', provenance: { source: 'user' },
    });
  });

  it('generates missing ids for open questions and assumptions', () => {
    const parsed = RefinementProposalSchema.parse(normalizeProposal({
      id: 'a', kind: 'assessment', itemId: 'i', generatedAt: '2026-11-03T00:00:00.000Z', summary: 's',
      openQuestions: [{ text: 'Which retention period?', importance: 'important' }],
      assumptions: [{ text: 'DUTO applies' }],
    }));
    expect(parsed.kind === 'assessment' && parsed.openQuestions[0].id).toMatch(/^question-/);
    expect(parsed.kind === 'assessment' && parsed.assumptions[0].id).toMatch(/^assumption-/);
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
});
