import { z } from "zod";
import { BacklogItemSchema, QualityAssessmentSchema, maxRevisions, type BacklogItem, type BacklogItemType } from "../domain/backlog-item";
import { applySectionUpdates, conformToTemplate } from "../domain/document";
import { DomainError } from "../domain/errors";
import {
  addRelationship,
  shouldStopAutonomousRefinement,
  transitionItemStatus,
} from "../domain/services";
import { RefinementProposalSchema, type RefinementProposal } from "../domain/proposal";
import { RefinementSessionSchema, type RefinementSession } from "../domain/refinement-session";
import type { BacklogRelationship } from "../domain/relationship";
import type { ProjectSource } from "../domain/project";
import type { Clock, IdGenerator, RefinementProvider, RefinementStore } from "./ports";

export interface RefinementServiceOptions {
  store: RefinementStore;
  provider: RefinementProvider;
  ids: IdGenerator;
  clock?: Clock;
  /** Current (default or user-modified) template per item type; children are conformed to it. */
  templates?: Partial<Record<BacklogItemType, string>>;
  loadProjectSources?: (projectId: string) => Promise<readonly ProjectSource[]>;
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
    const sources = await this.selectedSources(item.projectId);
    const proposal = await this.generateValid((validationFeedback) => this.options.provider.generateAssessment({
      item,
      relatedItems,
      relationships,
      conversation: session.conversation,
      sources,
      validationFeedback,
    }, signal));
    if (proposal.kind !== "assessment" || proposal.itemId !== item.id) {
      throw new DomainError("Provider returned an assessment for the wrong item.", "INVALID_PROVIDER_PROPOSAL");
    }
    return proposal;
  }

  /** Read-only quality check; only `quality` on the item changes. */
  async assessQuality(itemId: string, signal?: AbortSignal): Promise<BacklogItem> {
    const provider = this.options.provider;
    if (!provider.generateQuality) throw new DomainError("This provider cannot assess quality.", "UNSUPPORTED");
    const item = await this.options.store.getItem(itemId);
    if (!item) throw new DomainError(`Backlog item ${itemId} was not found.`, "ITEM_NOT_FOUND");
    const allRelationships = await this.options.store.listRelationships();
    const relationships = allRelationships.filter((r) => r.sourceId === item.id || r.targetId === item.id);
    const relatedIds = new Set(relationships.map((r) => r.sourceId === item.id ? r.targetId : r.sourceId));
    const relatedItems = (await this.options.store.listItems()).filter((c) => relatedIds.has(c.id));
    const sources = await this.selectedSources(item.projectId);
    const generated = await provider.generateQuality({ item, relatedItems, relationships, conversation: [], sources }, signal);
    const parsed = z.object({ quality: QualityAssessmentSchema }).safeParse(generated);
    if (!parsed.success) {
      console.error("[backlog-refinement] Quality response failed validation", parsed.error.issues, generated);
      throw new DomainError(`The model response did not match the expected format (${parsed.error.issues[0]?.path.join(".") ?? "response"}: ${parsed.error.issues[0]?.message ?? "invalid"}). See the browser console for details.`, "INVALID_PROVIDER_PROPOSAL");
    }
    const latest = await this.options.store.getItem(itemId) ?? item;
    const updated = { ...latest, quality: parsed.data.quality, updatedAt: isoNow(this.clock) };
    await this.options.store.saveItem(updated);
    return updated;
  }

  async proposeDecomposition(sessionId: string, signal?: AbortSignal, childType?: BacklogItemType): Promise<RefinementProposal> {
    const { session, item, relatedItems, relationships } = await this.loadGenerationContext(sessionId);
    const sources = await this.selectedSources(item.projectId);
    const proposal = await this.generateValid((validationFeedback) => this.options.provider.generateDecomposition({
      item,
      relatedItems,
      relationships,
      conversation: session.conversation,
      sources,
      childType,
      validationFeedback,
    }, signal));
    if (proposal.kind !== "decomposition" || proposal.parentItemId !== item.id) {
      throw new DomainError("Provider returned a decomposition for the wrong item.", "INVALID_PROVIDER_PROPOSAL");
    }
    return { ...proposal, children: proposal.children.map((child) => this.conformChild(child)) };
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

  /** Warnings (e.g. kept confirmed items) from the most recent accepted assessment. */
  lastWarnings: string[] = [];

  /** Restore the most recent revision of an item (undo the last AI change). */
  async undoLastChange(itemId: string): Promise<BacklogItem> {
    const item = await this.options.store.getItem(itemId);
    if (!item) throw new DomainError(`Backlog item ${itemId} was not found.`, "ITEM_NOT_FOUND");
    const previous = item.revisions[item.revisions.length - 1];
    if (!previous) throw new DomainError("There is no earlier version to restore.", "NO_REVISION");
    const restored = BacklogItemSchema.parse({
      ...item,
      title: previous.title,
      description: previous.description,
      revisions: item.revisions.slice(0, -1),
      updatedAt: isoNow(this.clock),
    });
    await this.options.store.saveItem(restored);
    return restored;
  }

  async acceptProposal(
    proposalInput: RefinementProposal,
    selectedProposalIds?: readonly string[],
  ): Promise<BacklogItem[]> {
    const proposal = RefinementProposalSchema.parse(pruneDanglingRelationships(proposalInput));
    if (proposal.kind === "assessment") {
      const item = await this.options.store.getItem(proposal.itemId);
      if (!item) throw new DomainError(`Backlog item ${proposal.itemId} was not found.`, "ITEM_NOT_FOUND");
      const merged = applySectionUpdates(item.description, proposal.sectionUpdates);
      const title = proposal.suggestedTitle ?? item.title;
      const changed = merged.document !== item.description || title !== item.title;
      this.lastWarnings = merged.warnings;
      const now = isoNow(this.clock);
      const updated: BacklogItem = {
        ...item,
        title,
        description: merged.document,
        revisions: changed
          ? [...item.revisions, { title: item.title, description: item.description, savedAt: now }].slice(-maxRevisions)
          : item.revisions,
        quality: proposal.quality ?? item.quality,
        updatedAt: now,
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

  private conformChild<T extends { type: BacklogItemType; title: string; description: string }>(child: T): T {
    const template = this.options.templates?.[child.type];
    if (!template?.trim()) return child;
    const { document, extraHeadings } = conformToTemplate(template, child.description);
    if (extraHeadings.length) {
      console.warn(`[backlog-refinement] Child "${child.title}" used headings outside the template; kept under "Additional notes"`, extraHeadings);
    }
    return { ...child, description: document };
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
    const selectedChildren = proposal.children
      .filter(({ proposalId }) => selected.has(proposalId))
      .map((child) => this.conformChild(child));
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
          projectId: parent.projectId,
          type: child.type,
          title: child.title,
          description: child.description,
          status: "draft",
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

  /** Retries once, telling the model what was wrong with its first answer. */
  private async generateValid(generate: (validationFeedback?: string) => Promise<unknown>): Promise<RefinementProposal> {
    try {
      return this.parseProposal(await generate());
    } catch (cause) {
      if (!(cause instanceof DomainError) || cause.code !== "INVALID_PROVIDER_PROPOSAL") throw cause;
      console.warn("[backlog-refinement] Retrying once after an invalid model response");
      return this.parseProposal(await generate(cause.message));
    }
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

  private async selectedSources(projectId: string): Promise<{ name: string; url?: string; text: string }[]> {
    if (!this.options.loadProjectSources) return [];
    const sources = (await this.options.loadProjectSources(projectId)).filter((source) => source.selected);
    if (sources.some((source) => source.projectId !== projectId)) {
      throw new DomainError("Selected sources must belong to this project.", "INVALID_PROJECT_SOURCE");
    }
    if (sources.some((source) => !source.text.trim())) {
      throw new DomainError("A selected source has no text. Add text or deselect it before using AI.", "EMPTY_PROJECT_SOURCE");
    }
    if (sources.reduce((total, source) => total + source.text.length, 0) > 100_000) {
      throw new DomainError("Selected project sources exceed 100,000 characters. Deselect sources before using AI.", "PROJECT_CONTEXT_TOO_LARGE");
    }
    return sources.map(({ name, url, text }) => ({ name, ...(url ? { url } : {}), text }));
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
