import { joinSections, normalizeHeading, splitSections } from '../domain/document';

export type SectionChoice = 'mine' | 'theirs' | 'both';

export interface SectionMerge {
  /** Normalized heading; the empty key is the text before the first `##` heading. */
  key: string;
  heading: string;
  /** `undefined` means the section does not exist on that side. */
  base?: string;
  mine?: string;
  theirs?: string;
  /** Changed differently on both sides: needs a choice. */
  conflict: boolean;
  /** The body when there is no conflict (`undefined` = section removed). */
  auto?: string;
}

export interface FieldMerge { base: string; mine: string; theirs: string; conflict: boolean; auto: string }

export interface MergePlan {
  title: FieldMerge;
  sections: SectionMerge[];
  /** True when at least one title or section needs a choice. */
  needsChoice: boolean;
}

export interface MergeInput { title: string; document: string }

function mergeField(base: string, mine: string, theirs: string): FieldMerge {
  if (mine === theirs) return { base, mine, theirs, conflict: false, auto: mine };
  if (mine === base) return { base, mine, theirs, conflict: false, auto: theirs };
  if (theirs === base) return { base, mine, theirs, conflict: false, auto: mine };
  return { base, mine, theirs, conflict: true, auto: mine };
}

interface Indexed { heading: string; body: string }

function index(document: string): { preamble: string; byKey: Map<string, Indexed> } {
  const { preamble, sections } = splitSections(document);
  return { preamble, byKey: new Map(sections.map((section) => [normalizeHeading(section.heading), { heading: section.heading, body: section.body }])) };
}

/**
 * Three-way, section-level merge of two edits of one item. A section that only one side changed takes that change;
 * a section changed differently on both sides is a conflict. The text before the first heading counts as a section too.
 */
export function planMerge(base: MergeInput, mine: MergeInput, theirs: MergeInput): MergePlan {
  const b = index(base.document);
  const m = index(mine.document);
  const t = index(theirs.document);
  const keys = [...new Set(['', ...t.byKey.keys(), ...m.byKey.keys(), ...b.byKey.keys()])];
  const sections = keys.map((key): SectionMerge => {
    const read = (side: ReturnType<typeof index>) => key === '' ? side.preamble : side.byKey.get(key)?.body;
    const [vb, vm, vt] = [read(b), read(m), read(t)];
    const heading = (t.byKey.get(key) ?? m.byKey.get(key) ?? b.byKey.get(key))?.heading ?? '';
    const section: SectionMerge = { key, heading, base: vb, mine: vm, theirs: vt, conflict: false };
    if (vm === vt) section.auto = vm;
    else if (vm === vb) section.auto = vt;
    else if (vt === vb) section.auto = vm;
    else section.conflict = true;
    return section;
  }).filter((section) => section.conflict || section.auto !== undefined || section.key === '');
  const title = mergeField(base.title, mine.title, theirs.title);
  return { title, sections, needsChoice: title.conflict || sections.some((section) => section.conflict) };
}

function bothBodies(section: SectionMerge): string | undefined {
  const parts = [section.mine, section.theirs].filter((part): part is string => part !== undefined && part !== '');
  if (!parts.length) return section.mine ?? section.theirs;
  return parts.join('\n\n');
}

/** Builds the resolved item. `choices` is only read for conflicting sections (default: mine) and `titleChoice` for a title conflict. */
export function applyMerge(plan: MergePlan, choices: Record<string, SectionChoice> = {}, titleChoice: Exclude<SectionChoice, 'both'> = 'mine'): MergeInput {
  const title = plan.title.conflict ? (titleChoice === 'theirs' ? plan.title.theirs : plan.title.mine) : plan.title.auto;
  let preamble = '';
  const sections: { heading: string; body: string }[] = [];
  for (const section of plan.sections) {
    let body: string | undefined;
    if (!section.conflict) body = section.auto;
    else {
      const choice = choices[section.key] ?? 'mine';
      body = choice === 'theirs' ? section.theirs : choice === 'both' ? bothBodies(section) : section.mine;
    }
    if (section.key === '') preamble = body ?? '';
    else if (body !== undefined) sections.push({ heading: section.heading, body });
  }
  return { title, document: joinSections({ preamble, sections }) };
}
