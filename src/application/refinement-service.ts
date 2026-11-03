import { z } from "zod";
import { BacklogItemSchema, type BacklogItem } from "../domain/backlog-item";
import { DomainError } from "../domain/errors";
import {
  addRelationship,
  shouldStopAutonomousRefinement,
  transitionItemStatus,
} from "../domain/services";
import { RefinementProposalSchema, type RefinementProposal } from "../domain/proposal";
import { RefinementSessionSchema, type RefinementSession } from "../domain/refinement-session";
import type { BacklogRelationship } from "../domain/relationship";
import type { Clock, IdGenerator, RefinementProvider, RefinementStore } from "./ports";

export interface RefinementServiceOptions {
  store: RefinementStore;
  provider: RefinementProvider;
  ids: IdGenerator;
  clock?: Clock;
}

export interface AutonomousRunResult {
  proposals: RefinementProposal[];
  iterations: number;
  stopReason: "max-iterations" | "ready" | "ready-with-open-questions" | "complete";
}

const systemClock: Clock = { now: () => new Date() };

function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

function mergeById<T extends { id: string }>(current: readonly T[], additions: readonly T[]): T[] {
  const merged = new Map(current.map((value) => [value.id, value]));
  for (const value of additions) merged.set(value.id, value);
  return [...merged.values()];
}

function mergeByKey<T>(current: readonly T[], additions: readonly T[], keyOf: (value: T) => string): T[] {
  const merged = new Map(current.map((value) => [keyOf(value), value]));
  for (const value of additions) merged.set(keyOf(value), value);
  return [...merged.values()];
}

export class RefinementApplicationService {
  private readonly clock: Clock;

  constructor(private readonly options: RefinementServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async beginRefinement(sessionId: string): Promise<BacklogItem> {
    const session = await this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new DomainError("Only an active session can begin refinement.", "SESSION_NOT_ACTIVE");
    }
    const item = await this.options.store.getItem(session.backlogItemId);
    if (!item) {
      throw new DomainError(`Backlog item ${session.backlogItemId} was not found.`, "ITEM_NOT_FOUND");
    }
    if (item.status === "draft") {
      const updated = transitionItemStatus(item, "refining", isoNow(this.clock));
      await this.options.store.saveItem(updated);
      return updated;
    }
    if (item.status !== "refining") {
      throw new DomainError("Only draft or refining items can start a refinement.", "ITEM_NOT_REFINABLE");
    }
    return item;
  }

  async recordHumanMessage(sessionId: string, content: string): Promise<RefinementSession> {
    const session = await this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new DomainError("Messages can only be added to an active session.", "SESSION_NOT_ACTIVE");
    }
    const now = isoNow(this.clock);
    const updated = RefinementSessionSchema.parse({
      ...session,
      conversation: [
        ...session.conversation,
        { id: this.options.ids.nextId(), role: "user", content, createdAt: now },
      ],
      pendingQuestions: [],
      updatedAt: now,
    });
    await this.options.store.saveSession(updated);
    return updated;
  }

  async proposeAssessment(sessionId: string, signal?: AbortSignal): Promise<RefinementProposal> {
    const { session, item, relatedItems, relationships } = await this.loadGenerationContext(sessionId);
    const generated = await this.options.provider.generateAssessment({
      item,
      relatedItems,
      relationships,
      conversation: session.conversation,
    }, signal);
    const proposal = this.parseProposal(generated);
    if (proposal.kind !== "assessment" || proposal.itemId !== item.id) {
      throw new DomainError("Provider returned an assessment for the wrong item.", "INVALID_PROVIDER_PROPOSAL");
    }
    return proposal;
  }

  async proposeDecomposition(sessionId: string, signal?: AbortSignal): Promise<RefinementProposal> {
    const { session, item, relatedItems, relationships } = await this.loadGenerationContext(sessionId);
    const generated = await this.options.provider.generateDecomposition({
      item,
      relatedItems,
      relationships,
      conversation: session.conversation,
    }, signal);
    const proposal = this.parseProposal(generated);
    if (proposal.kind !== "decomposition" || proposal.parentItemId !== item.id) {
      throw new DomainError("Provider returned a decomposition for the wrong item.", "INVALID_PROVIDER_PROPOSAL");
    }
    return proposal;
  }

  /**
   * Autonomous generation is bounded and read-only: it returns candidate proposals
   * without changing backlog items or sessions. Human acceptance is a separate action.
   */
  async runBoundedAutonomousRefinement(
    sessionId: string,
    maxIterations: number,
  ): Promise<AutonomousRunResult> {
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new DomainError("maxIterations must be a positive integer.", "INVALID_ITERATION_LIMIT");
    }
    const proposals: RefinementProposal[] = [];
    let iterations = 0;
    const session = await this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new DomainError("Generation requires an active refinement session.", "SESSION_NOT_ACTIVE");
    }
    let current = await this.requireItemForSession(sessionId);
    while (
      session.forceGeneration
        ? iterations < maxIterations
        : !shouldStopAutonomousRefinement(current, maxIterations, iterations)
    ) {
      const proposal = await this.proposeAssessment(sessionId);
      proposals.push(proposal);
      iterations += 1;
      if (proposal.kind === "assessment" && proposal.suggestedStatus) {
        current = { ...current, status: proposal.suggestedStatus };
      }
    }
    const stopReason = !session.forceGeneration &&
      (current.status === "ready" ||
        current.status === "ready-with-open-questions" ||
        current.status === "complete")
      ? current.status
      : "max-iterations";
    return { proposals, iterations, stopReason };
  }

  /** Return an edited candidate after schema validation; nothing is persisted yet. */
  editProposal(proposal: RefinementProposal, edits: Partial<RefinementProposal>): RefinementProposal {
    return RefinementProposalSchema.parse({ ...proposal, ...edits });
  }

  rejectProposal(proposal: RefinementProposal): { proposalId: string; rejected: true } {
    const validated = RefinementProposalSchema.parse(proposal);
    return { proposalId: validated.id, rejected: true };
  }

  async acceptProposal(
    proposalInput: RefinementProposal,
    selectedProposalIds?: readonly string[],
  ): Promise<BacklogItem[]> {
    const proposal = RefinementProposalSchema.parse(pruneDanglingRelationships(proposalInput));
    if (proposal.kind === "assessment") {
      const item = await this.options.store.getItem(proposal.itemId);
      if (!item) throw new DomainError(`Backlog item ${proposal.itemId} was not found.`, "ITEM_NOT_FOUND");
      const updated: BacklogItem = {
        ...item,
        title: proposal.suggestedTitle ?? item.title,
        description: proposal.suggestedDescription ?? item.description,
        contextValues: mergeByKey(item.contextValues, proposal.contextValues, ({ key }) => key),
        assumptions: mergeById(item.assumptions, proposal.assumptions),
        openQuestions: mergeById(item.openQuestions, proposal.openQuestions),
        quality: proposal.quality ?? item.quality,
        updatedAt: isoNow(this.clock),
      };
      const withStatus = proposal.suggestedStatus
        ? transitionItemStatus(updated, proposal.suggestedStatus, isoNow(this.clock))
        : updated;
      const validated = BacklogItemSchema.parse(withStatus);
      await this.options.store.saveItem(validated);
      return [validated];
    }
    return this.acceptSelectedChildren(proposal, selectedProposalIds);
  }

  private async acceptSelectedChildren(
    proposal: Extract<RefinementProposal, { kind: "decomposition" }>,
    selectedProposalIds: readonly string[] = proposal.children.map(({ proposalId }) => proposalId),
  ): Promise<BacklogItem[]> {
    const selected = new Set(selectedProposalIds);
    if (selected.size === 0) throw new DomainError("Select at least one proposed child.", "EMPTY_SELECTION");
    if (selected.size !== selectedProposalIds.length) {
      throw new DomainError("A proposed child may only be selected once.", "DUPLICATE_SELECTION");
    }
    const selectedChildren = proposal.children.filter(({ proposalId }) => selected.has(proposalId));
    if (selectedChildren.length !== selected.size) {
      throw new DomainError("Selection contains an unknown proposed child.", "UNKNOWN_SELECTION");
    }
    const parent = await this.options.store.getItem(proposal.parentItemId);
    if (!parent) throw new DomainError(`Backlog item ${proposal.parentItemId} was not found.`, "ITEM_NOT_FOUND");
    await this.rejectDuplicateChildren(parent.id, selectedChildren);

    return this.options.store.transaction(async (store) => {
      const now = isoNow(this.clock);
      const created = selectedChildren.map((child) =>
        BacklogItemSchema.parse({
          id: this.options.ids.nextId(),
          type: child.type,
          title: child.title,
          description: child.description,
          status: "draft",
          contextValues: child.contextValues,
          assumptions: child.assumptions,
          openQuestions: child.openQuestions,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const idByProposalId = new Map(
        selectedChildren.map((child, index) => [child.proposalId, created[index].id]),
      );
      const candidateRelationships: BacklogRelationship[] = created.flatMap((child, index) => {
        const proposalId = selectedChildren[index].proposalId;
        const explicitlyLinked = proposal.relationships.some((relationship) =>
          relationship.type === "parent-child" &&
          relationship.sourceRef === proposal.parentItemId &&
          relationship.targetRef === proposalId);
        return explicitlyLinked ? [] : [{
          sourceId: parent.id,
          targetId: child.id,
          type: "parent-child" as const,
        }];
      });
      for (const relation of proposal.relationships) {
        const sourceId = idByProposalId.get(relation.sourceRef) ?? relation.sourceRef;
        const targetId = idByProposalId.get(relation.targetRef) ?? relation.targetRef;
        if (
          (relation.sourceRef !== proposal.parentItemId && !idByProposalId.has(relation.sourceRef)) ||
          (relation.targetRef !== proposal.parentItemId && !idByProposalId.has(relation.targetRef))
        ) continue;
        candidateRelationships.push({ sourceId, targetId, type: relation.type });
      }

      const allItems = [...await store.listItems(), ...created];
      let relationships = await store.listRelationships();
      for (const relationship of candidateRelationships) {
        relationships = addRelationship(allItems, relationships, relationship);
      }
      for (const item of created) await store.createItem(item);
      await store.saveRelationships(relationships);
      return created;
    });
  }

  private parseProposal(generated: unknown): RefinementProposal {
    const result = RefinementProposalSchema.safeParse(generated);
    if (result.success) return result.data;
    console.error("[backlog-refinement] Model response failed validation", result.error.issues, generated);
    const flatten = (issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] => issues.flatMap((issue) => {
      if (issue.code !== "invalid_union") return [issue];
      const branches = issue.errors.map((branch) => flatten(branch));
      const likely = branches.filter((branch) => !branch.some((entry) => entry.path[0] === "kind"));
      const pool = likely.length ? likely : branches;
      return pool.sort((a, b) => a.length - b.length)[0] ?? [issue];
    });
    const summary = flatten(result.error.issues).slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`).join("; ");
    throw new DomainError(
      `The model response did not match the expected format (${summary}). See the browser console for details.`,
      "INVALID_PROVIDER_PROPOSAL",
    );
  }

  private async rejectDuplicateChildren(
    parentId: string,
    children: readonly { type: string; title: string }[],
  ): Promise<void> {
    const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
    const relationships = await this.options.store.listRelationships();
    const items = await this.options.store.listItems();
    const siblingIds = new Set(relationships
      .filter((relationship) => relationship.type === "parent-child" && relationship.sourceId === parentId)
      .map((relationship) => relationship.targetId));
    const seen = new Set(items
      .filter((item) => siblingIds.has(item.id))
      .map((item) => `${item.type}:${normalize(item.title)}`));
    for (const child of children) {
      const key = `${child.type}:${normalize(child.title)}`;
      if (seen.has(key)) {
        throw new DomainError(
          `“${child.title}” duplicates an existing or selected item under this parent. Edit or deselect it.`,
          "DUPLICATE_PROPOSAL",
        );
      }
      seen.add(key);
    }
  }

  private async loadGenerationContext(sessionId: string) {
    const session = await this.requireSession(sessionId);
    if (session.status !== "active") {
      throw new DomainError("Generation requires an active refinement session.", "SESSION_NOT_ACTIVE");
    }
    const item = await this.requireItemForSession(sessionId);
    const allItems = await this.options.store.listItems();
    const allRelationships = await this.options.store.listRelationships();
    const relationships = allRelationships.filter((relationship) =>
      relationship.sourceId === item.id || relationship.targetId === item.id,
    );
    const relatedIds = new Set(relationships.map((relationship) =>
      relationship.sourceId === item.id ? relationship.targetId : relationship.sourceId,
    ));
    const relatedItems = allItems.filter((candidate) => relatedIds.has(candidate.id));
    return { session, item, relatedItems, relationships };
  }

  private async requireItemForSession(sessionId: string): Promise<BacklogItem> {
    const session = await this.requireSession(sessionId);
    const item = await this.options.store.getItem(session.backlogItemId);
    if (!item) throw new DomainError(`Backlog item ${session.backlogItemId} was not found.`, "ITEM_NOT_FOUND");
    return item;
  }

  private async requireSession(sessionId: string): Promise<RefinementSession> {
    const session = await this.options.store.getSession(sessionId);
    if (!session) throw new DomainError(`Refinement session ${sessionId} was not found.`, "SESSION_NOT_FOUND");
    return session;
  }
}

/** Drop relationships whose endpoints are neither the parent nor a remaining child. */
function pruneDanglingRelationships(proposal: RefinementProposal): RefinementProposal {
  if (proposal.kind !== "decomposition") return proposal;
  const refs = new Set([proposal.parentItemId, ...proposal.children.map(({ proposalId }) => proposalId)]);
  return {
    ...proposal,
    relationships: proposal.relationships.filter(({ sourceRef, targetRef }) => refs.has(sourceRef) && refs.has(targetRef)),
  };
}
