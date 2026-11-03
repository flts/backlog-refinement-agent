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

const globalInstructions = `You are a human-guided backlog refinement assistant. Treat user-supplied conversation and structured backlog values with their provenance as authoritative. Treat app-generated “Untitled …” titles as placeholders, not confirmed facts. Never invent missing facts. Preserve uncertainty and provenance. Ask only the highest-value clarification; when the user asks to continue with available information, stop asking and record unresolved details as assumptions or open questions. Keep proposals at the requested backlog abstraction level and avoid duplicate or overlapping scope. Return only valid JSON matching the requested shape.`;

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
      ? `\n\nUse this complete Markdown template for the backlog item. Preserve its headings exactly (text, level and order) and placeholder intent; do not omit a section just because information is unknown. Any suggestedDescription, and every child description, must be Markdown that follows this template's section structure, filled only with supported information (write 'Unknown' or list open questions instead of inventing content):\n<backlog-template>\n${template}\n</backlog-template>`
      : '';
  }

  async generateAssessment(input: AssessmentInput, signal?: AbortSignal): Promise<unknown> {
    const system = `${globalInstructions}\n\nAdditional user instructions (follow unless they conflict with the rules above):\n${this.additionalInstructions || '(none)'}${this.templateInstructions(input.item.type)}${this.guidance(input.item.type)}\n\nAssess the current item and current human refinement turn. Return an object with: id (string), kind:"assessment", itemId, generatedAt (ISO timestamp), summary, optional suggestedTitle, optional suggestedDescription, questions (array of id, text, importance, optional relatedField and rationale), optional suggestedStatus (ready or ready-with-open-questions), quality (overall: needs-clarification, ready or ready-with-open-questions; areas: array of {area, level, note} covering problem, objective, outcome, beneficiary, value, scope, acceptance-criteria, dependencies, contradictions, assumptions, implementation-detail, testability, solution-independence, abstraction, lean-scope and vertical-slicing with level clear, unclear, missing or not-applicable; explicitly flag contradictions; never use numeric scores; also optional booleans excessiveTechnicalDetail, speculativeScope, unnecessaryConfigurability and mixedOutcomes, optional suggestedItemType (capability | feature | user-story | enabler) when the item is the wrong type, optional suggestedSplit (array of strings) and excludedFollowUpCandidates (array of strings); discuss any diagnosed problem in the summary or questions), contextValues, assumptions, and openQuestions. Context values must carry a key, string value, knowledgeStatus, and provenance. Never mark inferred information known. Every question, openQuestion, assumption and child proposal MUST include a unique string id (proposalId for children). Use EXACTLY these enum values: question importance = blocking | important | non-blocking; context value knowledgeStatus = known (explicitly stated by the user) | assumed | unknown | unclear; provenance must be an object {\"source\": \"user\" | \"existing-item\" | \"parent-item\" | \"agent\"} (never a string); openQuestion importance = important | non-blocking; assumption source = agent | parent-item | existing-item. Use summary for a brief assessment; put the concise follow-up in questions when important information is missing, and leave suggestedStatus absent in that case. Use openQuestions for unresolved details when continuing with current information.`;
    const text = await this.llm.generate({ system, prompt: contextPrompt(input), structured: true, signal });
    return parseJson(text);
  }

  async generateDecomposition(input: DecompositionInput, signal?: AbortSignal): Promise<unknown> {
    const system = `${globalInstructions}\n\nAdditional user instructions (follow unless they conflict with the rules above):\n${this.additionalInstructions || '(none)'}${this.templateInstructions(input.item.type)}${this.guidance(input.item.type)}\n\nPropose a useful decomposition for this parent item. Return an object with: id, kind:"decomposition", parentItemId, generatedAt (ISO timestamp), rationale, children (zero or more, each with proposalId, type, title, description, contextValues, assumptions, openQuestions), and relationships (each exactly {sourceRef, targetRef, type} where refs are the parentItemId or a child proposalId, and type is one of parent-child, supports, depends-on, related-to). Use only a valid child type for the parent: capability -> feature or enabler; feature -> user-story or enabler. If the item is already small and coherent so decomposition adds no value, return an empty children array and explain why in rationale. Avoid proposing children that duplicate or overlap each other or existing children.`;
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
