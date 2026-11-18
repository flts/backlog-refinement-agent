import { describe, expect, it } from "vitest";
import {
  AssessmentProposalSchema,
  DecompositionProposalSchema,
} from "./proposal";

const base = {
  id: "proposal-1",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("proposal schemas", () => {
  it("validates an assessment proposal with questions and assumptions", () => {
    const proposal = AssessmentProposalSchema.parse({
      ...base,
      kind: "assessment",
      itemId: "item-1",
      summary: "The story needs measurable acceptance criteria.",
      sectionUpdates: [{ heading: "Assumptions", markdown: "- [ ] Users have an account." }],
    });
    expect(proposal.sectionUpdates[0].mode).toBe("replace");
  });

  it("requires decomposition relationship endpoints to reference proposal members", () => {
    const proposal = {
      ...base,
      kind: "decomposition",
      parentItemId: "parent",
      rationale: "Split by user journey.",
      children: [{ proposalId: "child-1", type: "feature", title: "Sign in" }],
      relationships: [{ sourceRef: "parent", targetRef: "child-1", type: "parent-child" }],
    };
    expect(DecompositionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(DecompositionProposalSchema.safeParse({
      ...proposal,
      relationships: [{ sourceRef: "elsewhere", targetRef: "child-1", type: "supports" }],
    }).success).toBe(false);
  });

  it("rejects duplicated child identifiers", () => {
    expect(DecompositionProposalSchema.safeParse({
      ...base,
      kind: "decomposition",
      parentItemId: "parent",
      rationale: "Split.",
      children: [
        { proposalId: "child", type: "feature", title: "One" },
        { proposalId: "child", type: "enabler", title: "Two" },
      ],
    }).success).toBe(false);
  });
});
