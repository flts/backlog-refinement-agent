import { assessmentLevels, backlogItemTypes, qualityAreas } from '../../domain/backlog-item';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function questionImportance(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (['blocking', 'important', 'non-blocking'].includes(text)) return text;
  if (/(block|critical|urgent|must)/.test(text)) return 'blocking';
  if (/(low|minor|optional|nice)/.test(text)) return 'non-blocking';
  return 'important';
}

function openQuestionImportance(value: unknown): string {
  return questionImportance(value) === 'non-blocking' ? 'non-blocking' : 'important';
}

function knowledgeStatus(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (['known', 'assumed', 'unknown', 'unclear'].includes(text)) return text;
  if (/(provided|confirmed|given|stated|user|explicit)/.test(text)) return 'known';
  if (/(assum|infer|likely|suggest)/.test(text)) return 'assumed';
  if (/(missing|none|absent)/.test(text)) return 'unknown';
  return 'unclear';
}

function provenance(value: unknown): Json {
  if (isObject(value) && typeof value.source === 'string') {
    const source = ['user', 'existing-item', 'parent-item', 'agent'].includes(value.source) ? value.source : 'agent';
    return { ...value, source };
  }
  const text = String(isObject(value) ? value.source ?? '' : value ?? '').toLowerCase();
  if (/(conversation|user|human|message)/.test(text)) return { source: 'user' };
  if (/parent/.test(text)) return { source: 'parent-item' };
  if (/(current|existing|item)/.test(text)) return { source: 'existing-item' };
  return { source: 'agent' };
}

const kebab = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');

function normalizeQuality(quality: unknown): unknown {
  if (!isObject(quality)) return quality;
  const result: Json = { ...quality };
  if (Array.isArray(quality.areas)) {
    result.areas = quality.areas.flatMap((entry) => {
      if (!isObject(entry)) return [];
      const area = kebab(entry.area);
      const level = kebab(entry.level);
      return (qualityAreas as readonly string[]).includes(area) && (assessmentLevels as readonly string[]).includes(level)
        ? [{ ...entry, area, level }]
        : [];
    });
  }
  for (const key of ['excessiveTechnicalDetail', 'speculativeScope', 'unnecessaryConfigurability', 'mixedOutcomes']) {
    if (typeof result[key] !== 'boolean') delete result[key];
  }
  const type = kebab(result.suggestedItemType);
  if ((backlogItemTypes as readonly string[]).includes(type)) result.suggestedItemType = type;
  else delete result.suggestedItemType;
  for (const key of ['suggestedSplit', 'excludedFollowUpCandidates']) {
    if (Array.isArray(result[key])) result[key] = (result[key] as unknown[]).filter((v) => typeof v === 'string');
    else delete result[key];
  }
  return result;
}

function mapArray(value: unknown, map: (entry: Json) => Json): unknown {
  return Array.isArray(value) ? value.map((entry) => (isObject(entry) ? map(entry) : entry)) : value;
}

const normalizeContext = (entry: Json): Json => ({
  ...entry,
  knowledgeStatus: knowledgeStatus(entry.knowledgeStatus),
  provenance: provenance(entry.provenance),
});

const withId = (entry: Json, prefix: string): Json =>
  typeof entry.id === 'string' && entry.id.trim() ? entry : { ...entry, id: `${prefix}-${crypto.randomUUID()}` };

const normalizeAssumption = (entry: Json): Json => ({
  ...withId(entry, 'assumption'),
  ...(entry.source === undefined || ['agent', 'parent-item', 'existing-item'].includes(String(entry.source))
    ? {}
    : { source: 'agent' }),
});

const normalizeOpenQuestion = (entry: Json): Json => ({
  ...withId(entry, 'question'),
  ...(entry.importance === undefined ? {} : { importance: openQuestionImportance(entry.importance) }),
});

/** Coerces common, harmless deviations in model output; Zod still validates the result. */
export function normalizeProposal(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const normalizeNested = (entry: Json): Json => ({
    ...entry,
    contextValues: mapArray(entry.contextValues, normalizeContext),
    assumptions: mapArray(entry.assumptions, normalizeAssumption),
    openQuestions: mapArray(entry.openQuestions, normalizeOpenQuestion),
  });
  const result: Json = {
    ...normalizeNested(raw),
    questions: mapArray(raw.questions, (entry) => ({
      ...withId(entry, 'question'),
      importance: questionImportance(entry.importance),
    })),
  };
  if (raw.quality !== undefined) result.quality = normalizeQuality(raw.quality);
  if (Array.isArray(raw.children)) {
    result.children = mapArray(raw.children, (entry) => {
      const child = normalizeNested(entry);
      return typeof child.proposalId === 'string' && child.proposalId.trim()
        ? child
        : { ...child, proposalId: `child-${crypto.randomUUID()}` };
    });
  }
  if (Array.isArray(raw.relationships)) {
    const pick = (entry: Json, names: string[]) => names.map((name) => entry[name]).find((value) => typeof value === 'string' && value.trim());
    result.relationships = mapArray(raw.relationships, (entry) => ({
      type: entry.type,
      sourceRef: pick(entry, ['sourceRef', 'sourceId', 'sourceProposalId', 'fromProposalId', 'fromId', 'from', 'source']),
      targetRef: pick(entry, ['targetRef', 'targetId', 'targetProposalId', 'toProposalId', 'toId', 'to', 'target']),
    }));
  }
  for (const key of ['questions', 'children', 'contextValues', 'assumptions', 'openQuestions']) {
    if (result[key] === undefined || result[key] === null) delete result[key];
  }
  return result;
}
