import type { BacklogItem, BacklogItemStatus } from "./backlog-item";
import type { BacklogRelationship, RelationshipType } from "./relationship";
import type { RefinementSession } from "./refinement-session";
import { DomainError } from "./errors";

const allowedTransitions: Record<BacklogItemStatus, readonly BacklogItemStatus[]> = {
  draft: ["refining"],
  refining: ["draft", "ready", "ready-with-open-questions"],
  ready: ["refining", "complete"],
  "ready-with-open-questions": ["refining", "ready", "complete"],
  complete: ["refining"],
};

export function transitionItemStatus(
  item: BacklogItem,
  nextStatus: BacklogItemStatus,
  updatedAt: string,
): BacklogItem {
  if (item.status === nextStatus) return item;
  if (!allowedTransitions[item.status].includes(nextStatus)) {
    throw new DomainError(
      `Cannot transition backlog item from ${item.status} to ${nextStatus}.`,
      "INVALID_STATUS_TRANSITION",
    );
  }
  return { ...item, status: nextStatus, updatedAt };
}

function isSameRelationship(a: BacklogRelationship, b: BacklogRelationship): boolean {
  if (a.type !== b.type) return false;
  if (a.sourceId === b.sourceId && a.targetId === b.targetId) return true;
  return a.type === "related-to" && a.sourceId === b.targetId && a.targetId === b.sourceId;
}

function assertAcyclicParentChild(
  relationships: readonly BacklogRelationship[],
  candidate: BacklogRelationship,
): void {
  if (candidate.type !== "parent-child") return;
  const childrenByParent = new Map<string, string[]>();
  for (const relationship of relationships) {
    if (relationship.type !== "parent-child") continue;
    const children = childrenByParent.get(relationship.sourceId) ?? [];
    children.push(relationship.targetId);
    childrenByParent.set(relationship.sourceId, children);
  }

  const pending = [candidate.targetId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === candidate.sourceId) {
      throw new DomainError("Parent-child relationships cannot form a cycle.", "PARENT_CYCLE");
    }
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(childrenByParent.get(current) ?? []));
  }
}

export function addRelationship(
  items: readonly BacklogItem[],
  relationships: readonly BacklogRelationship[],
  candidate: BacklogRelationship,
): BacklogRelationship[] {
  if (candidate.sourceId === candidate.targetId) {
    throw new DomainError("An item cannot have a relationship with itself.", "SELF_RELATIONSHIP");
  }
  const itemIds = new Set(items.map(({ id }) => id));
  if (!itemIds.has(candidate.sourceId) || !itemIds.has(candidate.targetId)) {
    throw new DomainError("Both relationship endpoints must exist.", "MISSING_RELATIONSHIP_ENDPOINT");
  }
  if (relationships.some((existing) => isSameRelationship(existing, candidate))) {
    throw new DomainError("This relationship already exists.", "DUPLICATE_RELATIONSHIP");
  }
  if (
    candidate.type === "parent-child" &&
    relationships.some((existing) =>
      existing.type === "parent-child" && existing.targetId === candidate.targetId)
  ) {
    throw new DomainError("An item can have only one parent.", "MULTIPLE_PARENTS");
  }
  assertAcyclicParentChild(relationships, candidate);
  return [...relationships, candidate];
}

export function removeRelationship(
  relationships: readonly BacklogRelationship[],
  sourceId: string,
  targetId: string,
  type: RelationshipType,
): BacklogRelationship[] {
  return relationships.filter((relationship) =>
    !isSameRelationship(relationship, { sourceId, targetId, type }));
}

export interface ItemDeletionValidation {
  allowed: boolean;
  blockers: BacklogRelationship[];
  sessionIds: string[];
}

export function validateItemDeletion(
  itemId: string,
  relationships: readonly BacklogRelationship[],
  sessions: readonly RefinementSession[] = [],
): ItemDeletionValidation {
  const blockers = relationships.filter(
    ({ sourceId, targetId }) => sourceId === itemId || targetId === itemId,
  );
  const sessionIds = sessions
    .filter((session) => session.backlogItemId === itemId)
    .map((session) => session.id);
  return { allowed: blockers.length === 0 && sessionIds.length === 0, blockers, sessionIds };
}

export function assertItemCanBeDeleted(
  itemId: string,
  relationships: readonly BacklogRelationship[],
  sessions: readonly RefinementSession[] = [],
): void {
  const validation = validateItemDeletion(itemId, relationships, sessions);
  if (!validation.allowed) {
    throw new DomainError(
      `Cannot delete item ${itemId} while relationships or refinement sessions still reference it.`,
      "ITEM_HAS_RELATIONSHIPS",
    );
  }
}

export function shouldStopAutonomousRefinement(
  item: BacklogItem,
  maxIterations: number,
  currentIteration: number,
): boolean {
  return (
    currentIteration >= maxIterations ||
    item.status === "ready" ||
    item.status === "ready-with-open-questions" ||
    item.status === "complete"
  );
}
