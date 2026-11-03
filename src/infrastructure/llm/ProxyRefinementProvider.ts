import type { AssessmentInput, DecompositionInput, RefinementProvider } from '../../application/ports';
import type { AssessmentProposal, DecompositionProposal } from '../../domain/proposal';
import type { BacklogItemType } from '../../domain/backlog-item';
import type { LlmProvider } from './ProxyLlmProvider';
import { logError } from '../logging';
import { normalizeProposal } from './normalizeProposal';
import { defaultPrinciples, defaultTypeInstructions } from '../../defaults/instructions';

export interface AgentInstructions {
  principles: string;
  typeInstructions: Record<BacklogItemType, string>;
}

const globalInstructions = `You are a human-guided backlog refinement assistant. Treat user-supplied conversation and the current item document as authoritative. Treat app-generated “Untitled …” titles as placeholders, not confirmed facts. Never invent missing facts. Preserve uncertainty and provenance. Ask only the highest-value clarification; when the user asks to continue with available information, stop asking and record unresolved details as assumptions or open questions in the document. Keep proposals at the requested backlog abstraction level and avoid duplicate or overlapping scope. Return only valid JSON matching the requested shape.`;

function contextPrompt(input: AssessmentInput): string {
  const parentRelationships = input.relationships.filter((relationship) =>
    relationship.type === 'parent-child' && relationship.targetId === input.item.id,
  );
  const parentItems = input.relatedItems.filter((item) =>
    parentRelationships.some(({ sourceId }) => sourceId === item.id),
  );
  return JSON.stringify({
    currentItem: input.item,
    parentContext: parentItems,
    relatedItems: input.relatedItems,
    relationships: input.relationships,
    conversation: input.conversation,
  }, null, 2);
}

export class ProxyRefinementProvider implements RefinementProvider {
  constructor(
    private readonly llm: LlmProvider,
    private readonly additionalInstructions = '',
    private readonly templates?: Record<BacklogItemType, string>,
    private readonly instructions: AgentInstructions = { principles: defaultPrinciples, typeInstructions: defaultTypeInstructions },
  ) {}

  private guidance(type: BacklogItemType): string {
    return `\n\nGeneral backlog refinement principles:\n<principles>\n${this.instructions.principles}\n</principles>\n\nInstructions for this backlog item type (${type}):\n<type-instructions>\n${this.instructions.typeInstructions[type]}\n</type-instructions>`;
  }

  private templateInstructions(type: BacklogItemType): string {
    const template = this.templates?.[type];
    return template?.trim()
      ? `\n\nUse this complete Markdown template for the backlog item. The item description is ONE Markdown document that follows this template's headings. HTML comments in the template are hints for you; do not copy them. Keep the template's headings, and use the template's Assumptions and Open questions sections (if present) as GitHub task lists ('- [ ] text'); never invent content - write 'Unknown' or add an open question instead. Every child description must follow this template's structure:\n<backlog-template>\n${template}\n</backlog-template>`
      : '';
  }

  async generateAssessment(input: AssessmentInput, signal?: AbortSignal): Promise<unknown> {
    const system = `${globalInstructions}\n\nAdditional user instructions (follow unless they conflict with the rules above):\n${this.additionalInstructions || '(none)'}${this.templateInstructions(input.item.type)}${this.guidance(input.item.type)}\n\nAssess the current item and current human refinement turn. Return an object with: id (string), kind:"assessment", itemId, generatedAt (ISO timestamp), summary, optional suggestedTitle, optional sectionUpdates, questions (array of id, text, importance, optional relatedField and rationale), optional suggestedStatus (ready or ready-with-open-questions), quality (overall: needs-clarification, ready or ready-with-open-questions; areas: array of {area, level, note} covering problem, objective, outcome, beneficiary, value, scope, acceptance-criteria, dependencies, contradictions, assumptions, implementation-detail, testability, solution-independence, abstraction, lean-scope and vertical-slicing with level clear, unclear, missing or not-applicable; explicitly flag contradictions; never use numeric scores; also optional booleans excessiveTechnicalDetail, speculativeScope, unnecessaryConfigurability and mixedOutcomes, optional suggestedItemType (capability | feature | user-story | enabler) when the item is the wrong type, optional suggestedSplit (array of strings) and excludedFollowUpCandidates (array of strings); discuss any diagnosed problem in the summary or questions). sectionUpdates is an array of {heading, markdown, mode} where heading is an existing or new '##' heading of the item's document, markdown is the section body and mode is replace or append. Return ONLY the sections you change; untouched sections are kept by the app. Never remove or rewrite content the user wrote or confirmed ('- [x]' items); prefer mode append to add to a list. Record assumptions as '- [ ] text' lines under the Assumptions heading and unresolved details as '- [ ] text' under the Open questions heading. Every question and child proposal MUST include a unique string id (proposalId for children). Use EXACTLY these enum values: question importance = blocking | important | non-blocking. Use summary for a brief assessment; put the concise follow-up in questions when important information is missing, and leave suggestedStatus absent in that case. Use the Open questions section for unresolved details when continuing with current information.`;
    const text = await this.llm.generate({ system, prompt: contextPrompt(input), structured: true, signal });
    return parseJson(text);
  }

  async generateDecomposition(input: DecompositionInput, signal?: AbortSignal): Promise<unknown> {
    const childTypes = input.childType
      ? [input.childType]
      : (input.item.type === 'capability' ? ['feature', 'enabler'] : input.item.type === 'feature' ? ['user-story', 'enabler'] : []) as BacklogItemType[];
    const childGuidance = childTypes.map((type) => `${this.templateInstructions(type)}\n\nInstructions for child type ${type}:\n<type-instructions>\n${this.instructions.typeInstructions[type]}\n</type-instructions>`).join('');
    const system = `${globalInstructions}\n\nAdditional user instructions (follow unless they conflict with the rules above):\n${this.additionalInstructions || '(none)'}${childGuidance}${this.guidance(input.item.type)}\n\nPropose a useful decomposition for this parent item${input.childType ? `; propose only children of type ${input.childType}` : ''}. Return an object with: id, kind:"decomposition", parentItemId, generatedAt (ISO timestamp), rationale, children (zero or more, each with proposalId, type, title, description), and relationships (each exactly {sourceRef, targetRef, type} where refs are the parentItemId or a child proposalId, and type is one of parent-child, supports, depends-on, related-to). Each child description MUST be a Markdown document that uses exactly the headings of that child type's template, in the same order and level; do not add, rename or drop headings and do not invent your own structure. Fill in every section you can support from the parent item and the conversation so the child has a clear start. Record inferred but unconfirmed facts as '- [ ] text' lines under the Assumptions heading and unknown or unresolved points as '- [ ] text' lines under the Open questions heading (when the template has them); give every child at least one assumption or open question while anything is unconfirmed. Never invent facts: leave a section empty or turn the gap into an open question. Use only a valid child type for the parent: capability -> feature or enabler; feature -> user-story or enabler. If the item is already small and coherent so decomposition adds no value, return an empty children array and explain why in rationale. Avoid proposing children that duplicate or overlap each other or existing children.`;
    const text = await this.llm.generate({ system, prompt: contextPrompt(input), structured: true, signal });
    return parseJson(text);
  }
}

function parseJson(text: string): AssessmentProposal | DecompositionProposal {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return normalizeProposal(JSON.parse(unfenced)) as AssessmentProposal | DecompositionProposal;
  } catch (cause) {
    logError('The model response was not valid JSON', cause, { response: text.slice(0, 2000) });
    throw new Error('The model response was not valid JSON.', { cause });
  }
}
