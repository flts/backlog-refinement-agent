import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  AgentStateSchema,
  ApprovalResumeSchema,
  AskUserArgsSchema,
  AskUserResultSchema,
  ChildItemsResultSchema,
  DocumentChangesResultSchema,
  ForwardedPropsSchema,
  ProposeChildItemsArgsSchema,
  ProposeDocumentChangesArgsSchema,
  QualityAssessmentArgsSchema,
  ResumeEntrySchema,
  RunErrorCodeSchema,
  SetSessionTitleArgsSchema,
  SuggestNextActionsArgsSchema,
  initialAgentState,
  normalizeRunErrorCode,
  runErrorCodes,
} from './index';

const files = import.meta.glob('../../../../contracts/fixtures/tools/*/*/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const schemaFiles = import.meta.glob('../../../../contracts/schemas/*.schema.json', { eager: true, import: 'default' }) as Record<
  string,
  { properties?: Record<string, unknown> }
>;

const schemas: Record<string, ZodType> = {
  'ask-user.args': AskUserArgsSchema,
  'ask-user.result': AskUserResultSchema,
  'propose-document-changes.args': ProposeDocumentChangesArgsSchema,
  'document-changes.result': DocumentChangesResultSchema,
  'propose-child-items.args': ProposeChildItemsArgsSchema,
  'child-items.result': ChildItemsResultSchema,
  'approval-resume': ApprovalResumeSchema,
  'resume-entry': ResumeEntrySchema,
  'quality-assessment.args': QualityAssessmentArgsSchema,
  'suggest-next-actions.args': SuggestNextActionsArgsSchema,
  'set-session-title.args': SetSessionTitleArgsSchema,
  'agent-state': AgentStateSchema,
  'forwarded-props': ForwardedPropsSchema,
  'run-error-codes': RunErrorCodeSchema,
};

interface Fixture {
  contract: string;
  kind: string;
  name: string;
  data: unknown;
}

const fixtures: Fixture[] = Object.entries(files).map(([path, data]) => {
  const [, contract, kind, file] = /tools\/([^/]+)\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
  return { contract, kind, name: file, data };
});

describe('shared contract fixtures', () => {
  it('cover every contract with a Zod mirror', () => {
    expect(new Set(fixtures.map((f) => f.contract))).toEqual(new Set(Object.keys(schemas)));
    for (const name of Object.keys(schemas)) {
      expect(fixtures.some((f) => f.contract === name && f.kind === 'valid'), `${name}: valid`).toBe(true);
      expect(fixtures.some((f) => f.contract === name && f.kind === 'invalid'), `${name}: invalid`).toBe(true);
    }
  });

  it.each(fixtures.filter((f) => f.kind === 'valid'))('parses valid $contract/$name', ({ contract, data }) => {
    const result = schemas[contract].safeParse(data);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(fixtures.filter((f) => f.kind === 'invalid' || f.kind === 'semantic-invalid'))('rejects $kind $contract/$name', ({ contract, data }) => {
    expect(schemas[contract].safeParse(data).success).toBe(false);
  });

  it('only knows the fixture kinds valid, invalid and semantic-invalid', () => {
    expect(new Set(fixtures.map((f) => f.kind))).toEqual(new Set(['valid', 'invalid', 'semantic-invalid']));
  });
});

describe('contract details', () => {
  it('applies defaults for multiSelect and section mode', () => {
    const ask = AskUserArgsSchema.parse({ questions: [{ id: 'q', header: 'H', question: 'Q?', options: [{ label: 'A' }] }] });
    expect(ask.questions[0].multiSelect).toBe(false);
    const proposal = ProposeDocumentChangesArgsSchema.parse({
      summary: 's', baseVersion: 1, sections: [{ id: 's1', heading: 'A', markdown: 'm' }],
    });
    expect(proposal.sections[0].mode).toBe('replace');
  });

  it('initialises the agent state with preview null', () => {
    const state = initialAgentState('p1', 'i1', 'feature');
    expect(state.preview).toBeNull();
    expect(AgentStateSchema.parse(state)).toEqual(state);
  });

  it('keeps the error codes in sync with the JSON schema', () => {
    const schema = Object.entries(schemaFiles).find(([path]) => path.endsWith('run-error-codes.schema.json'))?.[1] as unknown as { enum: string[] };
    expect([...runErrorCodes]).toEqual(schema.enum);
    expect(normalizeRunErrorCode('ValueError')).toBe('INTERNAL');
    expect(normalizeRunErrorCode('RATE_LIMITED')).toBe('RATE_LIMITED');
  });

  it('keeps the top-level properties in sync with the JSON schemas', () => {
    const shapes: Record<string, ZodType> = {
      'ask-user.args': AskUserArgsSchema,
      'propose-document-changes.args': ProposeDocumentChangesArgsSchema,
      'propose-child-items.args': ProposeChildItemsArgsSchema,
      'quality-assessment.args': QualityAssessmentArgsSchema,
      'document-changes.result': DocumentChangesResultSchema,
      'child-items.result': ChildItemsResultSchema,
      'agent-state': AgentStateSchema,
    };
    for (const [name, zodSchema] of Object.entries(shapes)) {
      const entry = Object.entries(schemaFiles).find(([path]) => path.endsWith(`/${name}.schema.json`));
      expect(entry, name).toBeDefined();
      const jsonKeys = Object.keys(entry![1].properties ?? {}).sort();
      const zodKeys = Object.keys((zodSchema as unknown as { shape: Record<string, unknown> }).shape).sort();
      expect(zodKeys, name).toEqual(jsonKeys);
    }
  });
});
