import type { BacklogItem } from "../domain/backlog-item";
import type { BacklogRelationship } from "../domain/relationship";
import type { ConversationMessage, RefinementSession } from "../domain/refinement-session";
import type {
  AssessmentProposal,
  DecompositionProposal,
} from "../domain/proposal";

export interface AssessmentInput {
  item: BacklogItem;
  relatedItems: readonly BacklogItem[];
  relationships: readonly BacklogRelationship[];
  conversation: readonly ConversationMessage[];
}

export interface DecompositionInput extends AssessmentInput {}

/** Provider contract is intentionally protocol- and model-agnostic. */
export interface RefinementProvider {
  generateAssessment(input: AssessmentInput, signal?: AbortSignal): Promise<unknown>;
  generateDecomposition(input: DecompositionInput, signal?: AbortSignal): Promise<unknown>;
}

export interface RefinementStore {
  getItem(id: string): Promise<BacklogItem | undefined>;
  listItems(): Promise<BacklogItem[]>;
  saveItem(item: BacklogItem): Promise<void>;
  createItem(item: BacklogItem): Promise<void>;
  listRelationships(): Promise<BacklogRelationship[]>;
  saveRelationships(relationships: readonly BacklogRelationship[]): Promise<void>;
  getSession(id: string): Promise<RefinementSession | undefined>;
  saveSession(session: RefinementSession): Promise<void>;
  listSessionsForItem(itemId: string): Promise<RefinementSession[]>;
  deleteItemAndReferences(itemId: string): Promise<void>;
  /** Implementations should commit or roll back the callback as one unit. */
  transaction<T>(work: (store: RefinementStore) => Promise<T>): Promise<T>;
}

export interface IdGenerator {
  nextId(): string;
}

export interface Clock {
  now(): Date;
}
