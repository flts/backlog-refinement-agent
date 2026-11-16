import type { components } from './backlog.schema';

type Schemas = components['schemas'];

export type Me = Schemas['Me'];
export type Project = Schemas['ProjectOut'];
export type Member = Schemas['MemberOut'];
export type MemberRole = Member['role'];
export type Item = Schemas['ItemOut'];
export type ItemSummary = Schemas['ItemSummary'];
export type ItemType = Item['type'];
export type ItemStatus = Item['status'];
export type ItemChanges = Schemas['ItemUpdate'];
export type Revision = Schemas['RevisionSummary'];
export type RevisionDetail = Schemas['RevisionOut'];
export type Relationship = Schemas['RelationshipOut'];
export type RelationshipType = Relationship['type'];
export type Source = Schemas['SourceOut'];
export type SourceDetail = Schemas['SourceDetail'];
export type SourceMode = Source['mode'];
export type SourceList = Schemas['SourceList'];
export type EffectiveGuidance = Schemas['EffectiveGuidanceOut'];
export type GuidanceEntry = Schemas['GuidanceEntryOut'];
export type DefaultGuidance = Schemas['DefaultGuidanceOut'];
export type GuidanceWrite = Schemas['GuidanceWrite'];
/** Kinds with a per-item-type override; `principles` has its own endpoints. */
export type TypedGuidanceKind = 'type-instructions' | 'template';
