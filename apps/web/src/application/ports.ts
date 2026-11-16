import type { BacklogItem } from "../domain/backlog-item";
import type { BacklogRelationship } from "../domain/relationship";
import type { RefinementSession } from "../domain/refinement-session";

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
  deleteSession(id: string): Promise<void>;
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
