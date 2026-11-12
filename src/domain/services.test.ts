import { describe, expect, it } from "vitest";
import { BacklogItemSchema } from "./backlog-item";
import { DomainError } from "./errors";
import { RefinementSessionSchema, transitionSessionStatus } from "./refinement-session";
import {
  addRelationship,
  assertItemCanBeDeleted,
  canTransitionItemStatus,
  shouldStopAutonomousRefinement,
  transitionItemStatus,
  validateItemDeletion,
} from "./services";

const timestamp = "2026-01-01T00:00:00.000Z";
const item = (id: string, status = "draft") => BacklogItemSchema.parse({
  id,
  projectId: "project-1",
  type: "feature",
  title: id,
  status,
  createdAt: timestamp,
  updatedAt: timestamp,
});

describe("backlog domain services", () => {
  it("does not fold legacy structured fields into the document and rejects invalid values", () => {
    const parsed = BacklogItemSchema.parse({
      id: "feature-1",
      projectId: "project-1",
      type: "feature",
      title: "Search",
      contextValues: [{
        key: "audience",
        value: "support staff",
        knowledgeStatus: "known",
        provenance: { source: "user" },
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.status).toBe("draft");
    expect(parsed.description).toBe("");
    expect(parsed).not.toHaveProperty("contextValues");
    expect(() => BacklogItemSchema.parse({ ...parsed, projectId: undefined })).toThrow();
    expect(() => BacklogItemSchema.parse({
      ...parsed,
      type: "epic",
    })).toThrow();
  });

  it("enforces allowed status transitions", () => {
    expect(transitionItemStatus(item("a"), "refining", timestamp).status).toBe("refining");
    expect(() => transitionItemStatus(item("a"), "ready", timestamp)).toThrow(DomainError);
    expect(transitionItemStatus(item("a", "refining"), "ready", timestamp).status).toBe("ready");
    for (const status of ["ready", "ready-with-open-questions", "complete"] as const) {
      expect(canTransitionItemStatus(status, "refining")).toBe(true);
      expect(transitionItemStatus(item("a", status), "refining", timestamp).status).toBe("refining");
    }
    expect(canTransitionItemStatus("draft", "ready")).toBe(false);
  });

  it("prevents self-links, duplicates, multiple parents, and parent cycles", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(() => addRelationship(items, [], { sourceId: "a", targetId: "a", type: "supports" }))
      .toThrow(/itself/);
    const parentChild = addRelationship(items, [], {
      sourceId: "a", targetId: "b", type: "parent-child",
    });
    expect(() => addRelationship(items, parentChild, {
      sourceId: "a", targetId: "b", type: "parent-child",
    })).toThrow(/already exists/);
    expect(() => addRelationship(items, parentChild, {
      sourceId: "c", targetId: "b", type: "parent-child",
    })).toThrow(/only one parent/);
    const chain = addRelationship(items, parentChild, {
      sourceId: "b", targetId: "c", type: "parent-child",
    });
    expect(() => addRelationship(items, chain, {
      sourceId: "c", targetId: "a", type: "parent-child",
    })).toThrow(/cycle/);
  });

  it("treats related-to as symmetric and blocks deletion while linked", () => {
    const items = [item("a"), item("b")];
    const links = addRelationship(items, [], {
      sourceId: "a", targetId: "b", type: "related-to",
    });
    expect(() => addRelationship(items, links, {
      sourceId: "b", targetId: "a", type: "related-to",
    })).toThrow(/already exists/);
    expect(validateItemDeletion("a", links)).toEqual({ allowed: false, blockers: links, sessionIds: [] });
    expect(() => assertItemCanBeDeleted("a", links)).toThrow(/relationships/);
    expect(validateItemDeletion("missing", links).allowed).toBe(true);
  });

  it("blocks deletion of items retained by a refinement session and validates session transitions", () => {
    const activeSession = RefinementSessionSchema.parse({
      id: "session-1",
      backlogItemId: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(validateItemDeletion("a", [], [activeSession])).toMatchObject({
      allowed: false,
      sessionIds: ["session-1"],
    });
    expect(transitionSessionStatus(activeSession, "paused", timestamp).status).toBe("paused");
    expect(() => transitionSessionStatus(
      transitionSessionStatus(activeSession, "complete", timestamp),
      "active",
      timestamp,
    )).toThrow(DomainError);
  });

  it("stops autonomous work at a terminal status or iteration limit", () => {
    expect(shouldStopAutonomousRefinement(item("a", "ready"), 4, 0)).toBe(true);
    expect(shouldStopAutonomousRefinement(item("a", "refining"), 3, 3)).toBe(true);
    expect(shouldStopAutonomousRefinement(item("a", "refining"), 3, 2)).toBe(false);
  });
});
