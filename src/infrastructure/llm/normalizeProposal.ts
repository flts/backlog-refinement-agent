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

const kebab = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');

export function normalizeQuality(quality: unknown): unknown {
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

const withId = (entry: Json, prefix: string): Json =>
  typeof entry.id === 'string' && entry.id.trim() ? entry : { ...entry, id: `${prefix}-${crypto.randomUUID()}` };

const asText = (value: unknown): string =>
  Array.isArray(value) ? value.map(asText).join('\n') : typeof value === 'string' ? value : '';

/** Normalize common section update shapes. */
function normalizeSectionUpdates(raw: Json): unknown[] {
  const updates: unknown[] = [];
  const list = Array.isArray(raw.sectionUpdates) ? raw.sectionUpdates : [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const heading = [entry.heading, entry.section, entry.title].find((v) => typeof v === 'string' && v.trim());
    const markdown = asText(entry.markdown ?? entry.content ?? entry.body ?? entry.text);
    if (typeof heading !== 'string') continue;
    updates.push({ heading: heading.replace(/^#+\s*/, '').trim(), markdown, mode: entry.mode === 'append' ? 'append' : 'replace' });
  }
  return updates;
}

/** Coerces common, harmless deviations in model output; Zod still validates the result. */
export function normalizeProposal(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  if ('suggestedDescription' in raw) throw new Error('The model returned an unsupported suggestedDescription; use sectionUpdates instead.');
  const result: Json = {
    ...raw,
    questions: mapArray(raw.questions, (entry) => ({
      ...withId(entry, 'question'),
      importance: questionImportance(entry.importance),
    })),
  };
  if (raw.kind === 'assessment' || raw.sectionUpdates !== undefined) {
    result.sectionUpdates = normalizeSectionUpdates(raw);
  }
  if (raw.quality !== undefined) result.quality = normalizeQuality(raw.quality);
  if (Array.isArray(raw.children)) {
    result.children = mapArray(raw.children, (entry) => {
      const fromSections = Array.isArray(entry.sections)
        ? entry.sections.flatMap((section) => {
          if (!isObject(section)) return [];
          const heading = [section.heading, section.section, section.title].find((v) => typeof v === 'string' && v.trim());
          return typeof heading === 'string'
            ? [`## ${heading.replace(/^#+\s*/, '').trim()}\n${asText(section.markdown ?? section.content ?? section.body ?? section.text).trim()}`]
            : [];
        }).join('\n\n')
        : '';
      const child: Json = { ...entry, description: fromSections || asText(entry.description) };
      delete child.sections;
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
  for (const key of ['questions', 'children']) {
    if (result[key] === undefined || result[key] === null) delete result[key];
  }
  return result;
}
