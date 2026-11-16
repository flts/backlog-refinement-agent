"""Pydantic schemas for items, revisions, relationships and quality assessments (camelCase JSON)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from backlog_api.api.schemas import ApiModel, ApiRequest

ItemTypeName = Literal["capability", "feature", "user-story", "enabler"]
ItemStatusName = Literal["draft", "refining", "ready", "ready-with-open-questions", "complete"]
RelationshipTypeName = Literal["parent-child", "supports", "depends-on", "related-to"]
RevisionOrigin = Literal["manual", "agent", "restore"]

MAX_TITLE_LENGTH = 300
MAX_DOCUMENT_CHARS = 200_000

ItemTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TITLE_LENGTH)]
ItemDocument = Annotated[str, Field(max_length=MAX_DOCUMENT_CHARS)]

AssessmentArea = Literal[
    "problem",
    "objective",
    "outcome",
    "beneficiary",
    "value",
    "scope",
    "acceptance-criteria",
    "dependencies",
    "contradictions",
    "assumptions",
    "implementation-detail",
    "testability",
    "solution-independence",
    "abstraction",
    "lean-scope",
    "vertical-slicing",
]
AssessmentLevel = Literal["clear", "unclear", "missing", "not-applicable"]
QualityOverall = Literal["needs-clarification", "ready", "ready-with-open-questions"]


class QualityArea(ApiRequest):
    area: AssessmentArea
    level: AssessmentLevel
    note: str | None = Field(default=None, max_length=2000)


class QualityAssessment(ApiRequest):
    """A quality assessment of an item's document (mirrors the SPA's ``QualityAssessmentSchema``)."""

    areas: list[QualityArea] = Field(default_factory=list, max_length=32)
    overall: QualityOverall
    excessive_technical_detail: bool | None = None
    speculative_scope: bool | None = None
    unnecessary_configurability: bool | None = None
    mixed_outcomes: bool | None = None
    suggested_item_type: ItemTypeName | None = None
    suggested_split: list[str] | None = Field(default=None, max_length=20)
    excluded_follow_up_candidates: list[str] | None = Field(default=None, max_length=20)
    summary: str | None = Field(default=None, max_length=4000)


class QualityOut(ApiModel):
    assessment: dict[str, object] = Field(description="The stored assessment (see QualityAssessment).")
    assessed_at: datetime | None
    document_hash: str | None = Field(description="Hash of the document that was assessed.")
    stale: bool = Field(description="True when the document changed after the assessment.")


class QualitySummary(ApiModel):
    overall: QualityOverall | None
    assessed_at: datetime | None
    stale: bool


class ItemSummary(ApiModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    type: ItemTypeName
    title: str
    status: ItemStatusName
    version: int
    quality: QualitySummary | None
    updated_at: datetime
    updated_by: str


class ItemList(ApiModel):
    items: list[ItemSummary]


class ItemOut(ApiModel):
    id: uuid.UUID
    project_id: uuid.UUID
    parent_id: uuid.UUID | None
    type: ItemTypeName
    title: str
    document: str
    status: ItemStatusName
    version: int
    document_hash: str = Field(description="SHA-256 of the normalised document.")
    quality: QualityOut | None
    created_by: str
    updated_by: str
    created_at: datetime
    updated_at: datetime


class ItemCreate(ApiRequest):
    type: ItemTypeName
    title: ItemTitle | None = Field(default=None, description="Defaults to 'Untitled <Type>'.")
    document: ItemDocument | None = Field(
        default=None, description="Markdown; conformed to the type's template. Empty template structure by default."
    )
    parent_id: uuid.UUID | None = Field(default=None, description="Creates a parent-child relationship.")


class ItemUpdate(ApiRequest):
    title: ItemTitle | None = None
    document: ItemDocument | None = None
    status: ItemStatusName | None = None


class QualityUpdate(ApiRequest):
    quality: QualityAssessment
    document_hash: str = Field(
        min_length=64, max_length=64, description="Hash of the document that was assessed (from the item)."
    )


class RevisionSummary(ApiModel):
    id: uuid.UUID
    item_id: uuid.UUID
    version: int
    title: str
    origin: RevisionOrigin
    label: str | None
    actor: str
    run_id: str | None
    created_at: datetime


class RevisionOut(RevisionSummary):
    document: str


class RevisionList(ApiModel):
    items: list[RevisionSummary]


class RelationshipOut(ApiModel):
    id: uuid.UUID
    project_id: uuid.UUID
    source_id: uuid.UUID
    target_id: uuid.UUID
    type: RelationshipTypeName


class RelationshipList(ApiModel):
    items: list[RelationshipOut]


class RelationshipCreate(ApiRequest):
    source_id: uuid.UUID
    target_id: uuid.UUID
    type: RelationshipTypeName
