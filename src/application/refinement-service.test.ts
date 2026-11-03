import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../domain/backlog-item";
import type { BacklogRelationship } from "../domain/relationship";
import type { RefinementSession } from "../domain/refinement-session";
import type { RefinementProposal } from "../domain/proposal";
import type { RefinementProvider, RefinementStore } from "./ports";
import { RefinementApplicationService } from "./refinement-service";

const timestamp = "2026-01-01T00:00:00.000Z";
const parent: BacklogItem = {
  id: "parent",
  type: "capability",
  title: "Account management",
  description: "",
  status: "draft",
  contextValues: [],
  assumptions: [],
  openQuestions: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const session: RefinementSession = {
  id: "session",
  backlogItemId: parent.id,
  conversation: [],
  pendingQuestions: [],
  status: "active",
  forceGeneration: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};

class MemoryStore implements RefinementStore {
  items = new Map([[parent.id, parent]]);
  sessions = new Map([[session.id, session]]);
  relationships: BacklogRelationship[] = [];

  async getItem(id: string) { return this.items.get(id); }
  async listItems() { return [...this.items.values()]; }
  async saveItem(item: BacklogItem) { this.items.set(item.id, item); }
  async createItem(item: BacklogItem) {
    if (this.items.has(item.id)) throw new Error("duplicate id");
    this.items.set(item.id, item);
  }
  async listRelationships() { return [...this.relationships]; }
  async saveRelationships(relationships: readonly BacklogRelationship[]) {
    this.relationships = [...relationships];
  }
  async getSession(id: string) { return this.sessions.get(id); }
  async saveSession(value: RefinementSession) { this.sessions.set(value.id, value); }
  async listSessionsForItem(itemId: string) {
    return [...this.sessions.values()].filter((value) => value.backlogItemId === itemId);
  }
  async deleteItemAndReferences(id: string) {
    this.items.delete(id);
    this.relationships = this.relationships.filter(
      ({ sourceId, targetId }) => sourceId !== id && targetId !== id,
    );
    for (const [sessionId, value] of this.sessions) {
      if (value.backlogItemId === id) this.sessions.delete(sessionId);
    }
  }
  async transaction<T>(work: (store: RefinementStore) => Promise<T>): Promise<T> { return work(this); }
}

class SequenceIds {
  private next = 0;
  nextId() { this.next += 1; return `generated-${this.next}`; }
}

const assessment: RefinementProposal = {
  id: "assessment-1",
  kind: "assessment",
  itemId: parent.id,
  generatedAt: timestamp,
  summary: "The capability needs a measurable outcome.",
  questions: [],
  contextValues: [],
  assumptions: [],
  openQuestions: [],
  suggestedTitle: "Manage accounts",
};
const decomposition: RefinementProposal = {
  id: "decomposition-1",
  kind: "decomposition",
  parentItemId: parent.id,
  generatedAt: timestamp,
  rationale: "Separate sign-in from profile changes.",
  children: [
    { proposalId: "sign-in", type: "feature", title: "Sign in", description: "", contextValues: [], assumptions: [], openQuestions: [] },
    { proposalId: "profile", type: "user-story", title: "Update profile", description: "", contextValues: [], assumptions: [], openQuestions: [] },
  ],
  relationships: [
    { sourceRef: parent.id, targetRef: "sign-in", type: "parent-child" },
    { sourceRef: parent.id, targetRef: "profile", type: "parent-child" },
    { sourceRef: "sign-in", targetRef: "profile", type: "supports" },
  ],
};

describe("RefinementApplicationService", () => {
  it("records human input and leaves generated proposals temporary until acceptance", async () => {
    const store = new MemoryStore();
    const provider: RefinementProvider = {
      generateAssessment: async () => assessment,
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({
      store, provider, ids: new SequenceIds(), clock: { now: () => new Date(timestamp) },
    });

    await service.beginRefinement(session.id);
    const updatedSession = await service.recordHumanMessage(session.id, "Users need one sign-in.");
    expect(updatedSession.conversation[0].role).toBe("user");
    const generated = await service.proposeAssessment(session.id);
    expect(generated).toEqual(assessment);
    expect((await store.getItem(parent.id))?.title).toBe(parent.title);
    expect(await service.acceptProposal(generated)).toMatchObject([{ title: "Manage accounts" }]);
  });

  it("ignores relationships that point at children no longer in the proposal", async () => {
    const store = new MemoryStore();
    const provider: RefinementProvider = {
      generateAssessment: async () => assessment,
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });
    const stale = {
      ...decomposition,
      children: decomposition.children.slice(0, 1),
      relationships: [{ sourceRef: "removed-child", targetRef: decomposition.children[0].proposalId, type: "depends-on" as const }],
    };
    await expect(service.acceptProposal(stale)).resolves.toHaveLength(1);
  });

  it("accepts only selected decomposition children with their applicable relationships", async () => {
    const store = new MemoryStore();
    const provider: RefinementProvider = {
      generateAssessment: async () => assessment,
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });

    const created = await service.acceptProposal(decomposition, ["sign-in"]);
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe("Sign in");
    expect(store.relationships).toEqual([
      { sourceId: "parent", targetId: "generated-1", type: "parent-child" },
    ]);
    expect((await store.listItems()).map(({ title }) => title)).toEqual([
      "Account management", "Sign in",
    ]);
  });

  it("limits autonomous proposal generation and does not apply its candidates", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const provider: RefinementProvider = {
      generateAssessment: async () => { calls += 1; return assessment; },
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });
    await service.beginRefinement(session.id);
    const result = await service.runBoundedAutonomousRefinement(session.id, 2);

    expect(calls).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.stopReason).toBe("max-iterations");
    expect((await store.getItem(parent.id))?.title).toBe(parent.title);
  });

  it("honors forceGeneration while still respecting the autonomous iteration bound", async () => {
    const store = new MemoryStore();
    store.items.set(parent.id, { ...parent, status: "ready" });
    store.sessions.set(session.id, { ...session, forceGeneration: true });
    let calls = 0;
    const provider: RefinementProvider = {
      generateAssessment: async () => { calls += 1; return assessment; },
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });
    const result = await service.runBoundedAutonomousRefinement(session.id, 2);

    expect(calls).toBe(2);
    expect(result.stopReason).toBe("max-iterations");
  });

  it("rejects malformed provider output and rejects duplicate selections", async () => {
    const store = new MemoryStore();
    const provider: RefinementProvider = {
      generateAssessment: async () => ({ ...assessment, itemId: "another-item" }),
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });
    await expect(service.proposeAssessment(session.id)).rejects.toThrow(/wrong item/);
    await expect(service.acceptProposal(decomposition, ["sign-in", "sign-in"]))
      .rejects.toThrow(/only be selected once/);
  });
  it("rejects selected proposals that duplicate each other or an existing child", async () => {
    const store = new MemoryStore();
    const provider: RefinementProvider = {
      generateAssessment: async () => assessment,
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });
    const twin = { ...decomposition, children: [
      decomposition.kind === "decomposition" ? decomposition.children[0] : undefined,
      decomposition.kind === "decomposition" ? { ...decomposition.children[0], proposalId: "sign-in-2", title: " sign  IN " } : undefined,
    ], relationships: [] } as RefinementProposal;
    await expect(service.acceptProposal(twin)).rejects.toThrow(/duplicates/);
    await service.acceptProposal(decomposition, ["sign-in"]);
    await expect(service.acceptProposal(decomposition, ["sign-in"])).rejects.toThrow(/duplicates/);
  });

  it("allows a decomposition with no children when splitting adds no value", async () => {
    const { RefinementProposalSchema } = await import("../domain/proposal");
    expect(RefinementProposalSchema.parse({ ...decomposition, children: [], relationships: [] })).toMatchObject({ children: [] });
  });

  it("stores the structured quality assessment on the item", async () => {
    const store = new MemoryStore();
    const provider: RefinementProvider = {
      generateAssessment: async () => assessment,
      generateDecomposition: async () => decomposition,
    };
    const service = new RefinementApplicationService({ store, provider, ids: new SequenceIds() });
    const quality = { overall: "needs-clarification" as const, areas: [{ area: "objective" as const, level: "unclear" as const }] };
    await service.acceptProposal({ ...assessment, quality } as RefinementProposal);
    expect((await store.getItem(parent.id))?.quality).toEqual(quality);
  });
});
