import { describe, expect, it, vi } from 'vitest';
import type { AssessmentInput } from '../../application/ports';
import { ProxyRefinementProvider } from './ProxyRefinementProvider';

const item = {
  id: 'feature-1', type: 'feature' as const, title: 'Save history', description: '', status: 'refining' as const,
  revisions: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const input: AssessmentInput = {
  item,
  relatedItems: [{
    id: 'cap-1', type: 'capability', title: 'Conversation management', description: '', status: 'ready' as const,
    revisions: [],
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  }],
  relationships: [{ sourceId: 'cap-1', targetId: 'feature-1', type: 'parent-child' }],
  conversation: [],
};

describe('ProxyRefinementProvider', () => {
  it('passes parent context and user instructions to structured completion', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ kind: 'assessment' }));
    const templates = {
      capability: '',
      feature: '# Feature\n\n## Definition of done\n<!-- hint -->',
      'user-story': '',
      enabler: '',
    };
    const provider = new ProxyRefinementProvider({ generate }, 'Prefer concise questions.', templates);

    await provider.generateAssessment(input);

    const [request] = generate.mock.calls[0];
    expect(request.system).toContain('Prefer concise questions.');
    expect(request.system).toContain('## Definition of done');
    expect(request.prompt).toContain('Conversation management');
    expect(request.prompt).toContain('parentContext');
    expect(request.structured).toBe(true);
  });

  it('gives the decomposition prompt the child type template, not the parent one', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ kind: 'decomposition' }));
    const templates = {
      capability: '', feature: '## PARENT-ONLY heading',
      'user-story': '## Story\n<!-- hint -->', enabler: '## ENABLER heading',
    };
    await new ProxyRefinementProvider({ generate }, '', templates).generateDecomposition({ ...input, childType: 'user-story' });
    const system = generate.mock.calls[0][0].system;
    expect(system).toContain('## Story');
    expect(system).not.toContain('PARENT-ONLY heading');
    expect(system).not.toContain('ENABLER heading');
    expect(system).toContain('Open questions heading');
  });

  it('uses the default principles and type instructions unless the user customized them', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ kind: 'assessment' }));
    await new ProxyRefinementProvider({ generate }).generateAssessment(input);
    expect(generate.mock.calls[0][0].system).toContain('# Backlog Refinement Principles');
    expect(generate.mock.calls[0][0].system).toContain('# Feature Instructions');

    await new ProxyRefinementProvider({ generate }, '', undefined, {
      principles: 'CUSTOM PRINCIPLES',
      typeInstructions: { capability: '', feature: 'CUSTOM FEATURE RULES', 'user-story': '', enabler: '' },
    }).generateAssessment(input);
    const system = generate.mock.calls[1][0].system;
    expect(system).toContain('CUSTOM PRINCIPLES');
    expect(system).toContain('CUSTOM FEATURE RULES');
    expect(system).not.toContain('# Backlog Refinement Principles');
  });

  it('uses the supplied template verbatim, whether default or user-modified', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ kind: 'assessment' }));
    const custom = '# Mine\n\n## My own section\n<!-- hint -->';
    await new ProxyRefinementProvider({ generate }, '', {
      capability: '', feature: custom, 'user-story': '', enabler: '',
    }).generateAssessment(input);
    expect(generate.mock.calls[0][0].system).toContain(custom);
    expect(generate.mock.calls[0][0].system).toContain('<backlog-template>');
  });

  it('rejects malformed JSON rather than accepting a fallback response', async () => {
    const provider = new ProxyRefinementProvider({ generate: async () => 'not-json' });

    await expect(provider.generateAssessment(input)).rejects.toThrow('not valid JSON');
  });
});
