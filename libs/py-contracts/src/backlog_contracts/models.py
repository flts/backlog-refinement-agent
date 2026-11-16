"""Pydantic v2 mirrors of ``contracts/schemas``. JSON uses camelCase; Python uses snake_case (both are accepted).

Optional fields also accept an explicit ``null`` (LLMs often send it); the JSON Schemas remain the strict gate.
Models additionally enforce the rules JSON Schema cannot express (unique ids, ``recommended`` index in range, ...).
"""

from __future__ import annotations

import json
from enum import StrEnum
from typing import Annotated, Any, Final, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

ItemType = Literal["capability", "feature", "user-story", "enabler"]
SuggestedStatus = Literal["ready", "ready-with-open-questions"]
RelationshipType = Literal["parent-child", "supports", "depends-on", "related-to"]
AgentIntent = Literal["refine", "continue", "breakdown", "assess"]
AssessmentLevel = Literal["clear", "unclear", "missing", "not-applicable"]
QualityArea = Literal[
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

AGENT_STATE_SCHEMA_VERSION: Final = 1
FORWARDED_PROPS_MAX_LENGTH: Final = 512

NonEmptyStr = Annotated[str, Field(min_length=1)]


class ContractModel(BaseModel):
    """Base: camelCase aliases (snake_case accepted too), unknown keys rejected, strict types (no \"yes\" -> True)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid", strict=True)

    def to_wire(self) -> dict[str, Any]:
        """JSON-ready dict with camelCase keys; unset optional fields are omitted, explicit nulls are kept."""
        return self.model_dump(mode="json", by_alias=True, exclude_unset=True)


def _require_unique(values: list[str], what: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"{what} must be unique; '{value}' is repeated.")
        seen.add(value)


# --- ask_user -----------------------------------------------------------------------------------------------------


class AskUserOption(ContractModel):
    label: NonEmptyStr
    description: str | None = None


class AskUserQuestion(ContractModel):
    id: NonEmptyStr
    header: Annotated[str, Field(min_length=1, max_length=24)]
    question: NonEmptyStr
    rationale: str | None = None
    related_section: str | None = None
    options: Annotated[list[AskUserOption], Field(min_length=1, max_length=4)]
    recommended: Annotated[int, Field(ge=0, le=3)] | None = None
    multi_select: bool = False

    @model_validator(mode="after")
    def _recommended_in_range(self) -> Self:
        if self.recommended is not None and self.recommended >= len(self.options):
            raise ValueError("recommended must be an index into options.")
        return self


class AskUserArgs(ContractModel):
    questions: Annotated[list[AskUserQuestion], Field(min_length=1, max_length=3)]

    @model_validator(mode="after")
    def _unique_ids(self) -> Self:
        _require_unique([q.id for q in self.questions], "Question ids")
        return self


class AskUserAnswer(ContractModel):
    question_id: NonEmptyStr
    selected: list[str]
    freeform: str | None = None
    skipped: bool


class AskUserResult(ContractModel):
    status: Literal["answered", "skipped", "dismissed"]
    answers: list[AskUserAnswer]


# --- propose_document_changes -------------------------------------------------------------------------------------


class SectionChange(ContractModel):
    id: NonEmptyStr
    heading: Annotated[str, Field(min_length=1, max_length=200)]
    mode: Literal["replace", "append"] = "replace"
    markdown: str
    rationale: str | None = None


class ProposeDocumentChangesArgs(ContractModel):
    summary: NonEmptyStr
    suggested_title: NonEmptyStr | None = None
    suggested_status: SuggestedStatus | None = None
    base_version: Annotated[int, Field(ge=0)]
    sections: Annotated[list[SectionChange], Field(min_length=1, max_length=20)]

    @model_validator(mode="after")
    def _unique_ids(self) -> Self:
        _require_unique([s.id for s in self.sections], "Section ids")
        return self


class SectionConflict(ContractModel):
    section_id: NonEmptyStr
    heading: str
    reason: str
    current_markdown: str | None = None


class DocumentChangesResult(ContractModel):
    applied: list[str]
    edited: list[str]
    rejected: list[str]
    conflicted: list[SectionConflict]
    new_version: Annotated[int, Field(ge=0)]
    warnings: list[str] | None = None
    title_applied: bool | None = None
    status_applied: bool | None = None


class DocumentPreview(ContractModel):
    """Predictive preview: the (possibly incomplete) arguments of propose_document_changes."""

    summary: str | None = None
    suggested_title: str | None = None
    suggested_status: SuggestedStatus | None = None
    base_version: Annotated[int, Field(ge=0)] | None = None
    sections: list[SectionChange]


# --- propose_child_items ------------------------------------------------------------------------------------------


class ProposedChild(ContractModel):
    proposal_id: NonEmptyStr
    title: NonEmptyStr
    markdown: str


class ProposedRelationship(ContractModel):
    source_ref: NonEmptyStr
    target_ref: NonEmptyStr
    type: RelationshipType


class ProposeChildItemsArgs(ContractModel):
    rationale: NonEmptyStr
    child_type: ItemType
    children: Annotated[list[ProposedChild], Field(min_length=1, max_length=20)]
    relationships: Annotated[list[ProposedRelationship], Field(max_length=40)] | None = None

    @model_validator(mode="after")
    def _unique_ids(self) -> Self:
        _require_unique([c.proposal_id for c in self.children], "Child proposal ids")
        return self


class CreatedChild(ContractModel):
    proposal_id: NonEmptyStr
    item_id: NonEmptyStr
    title: str


class FailedChild(ContractModel):
    proposal_id: NonEmptyStr
    reason: str


class SkippedRelationship(ContractModel):
    source_ref: str
    target_ref: str
    reason: str


class ChildItemsResult(ContractModel):
    created: list[CreatedChild]
    edited: list[str]
    rejected: list[str]
    failed: list[FailedChild]
    relationships_created: Annotated[int, Field(ge=0)]
    relationships_skipped: list[SkippedRelationship] | None = None


class ChildPreview(ContractModel):
    """Predictive preview: the (possibly incomplete) arguments of propose_child_items."""

    rationale: str | None = None
    child_type: ItemType | None = None
    children: list[ProposedChild]
    relationships: list[ProposedRelationship] | None = None


# --- approval resume ----------------------------------------------------------------------------------------------


class ApprovalResume(ContractModel):
    """``payload`` of a resume entry. ``edited_args`` is a FULL replacement of the tool arguments (never merged)."""

    approved: bool
    edited_args: dict[str, Any] | None = None


class ResumeEntry(ContractModel):
    """One ``RunAgentInput.resume[]`` element; ``interrupt_id`` is ``interrupt.id`` (``af-call-...``)."""

    interrupt_id: NonEmptyStr
    status: Literal["resolved", "cancelled"]
    payload: ApprovalResume | None = None

    @model_validator(mode="after")
    def _payload_matches_status(self) -> Self:
        if self.status == "resolved" and self.payload is None:
            raise ValueError("A resolved resume entry needs a payload.")
        if self.status == "cancelled" and self.payload is not None:
            raise ValueError("A cancelled resume entry must not carry a payload.")
        return self


# --- quality / actions / title ------------------------------------------------------------------------------------


class QualityAreaAssessment(ContractModel):
    area: QualityArea
    level: AssessmentLevel
    note: str | None = None


class _QualityFields(ContractModel):
    overall: Literal["needs-clarification", "ready", "ready-with-open-questions"]
    areas: Annotated[list[QualityAreaAssessment], Field(max_length=32)]
    excessive_technical_detail: bool | None = None
    speculative_scope: bool | None = None
    unnecessary_configurability: bool | None = None
    mixed_outcomes: bool | None = None
    suggested_item_type: ItemType | None = None
    suggested_split: list[str] | None = None
    excluded_follow_up_candidates: list[str] | None = None
    summary: str | None = None
    document_hash: str | None = None


class QualityAssessmentArgs(_QualityFields):
    pass


class StateQuality(_QualityFields):
    """Latest assessment as mirrored into the shared state."""

    assessed_at: str | None = None


class NextAction(ContractModel):
    id: NonEmptyStr
    label: Annotated[str, Field(min_length=1, max_length=60)]
    intent: Literal["refine", "continue", "breakdown", "assess", "message"]
    prompt: str | None = None

    @model_validator(mode="after")
    def _message_needs_prompt(self) -> Self:
        if self.intent == "message" and self.prompt is None:
            raise ValueError("A message action needs a prompt.")
        return self


class SuggestNextActionsArgs(ContractModel):
    actions: Annotated[list[NextAction], Field(max_length=3)]


class SetSessionTitleArgs(ContractModel):
    title: Annotated[str, Field(min_length=1, max_length=60)]


# --- shared state, forwarded props, errors ------------------------------------------------------------------------


class AgentState(ContractModel):
    """Shared AG-UI state. ``preview`` is required and nullable: initialise it to ``None`` (see :meth:`initial`)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="allow", strict=True)

    schema_version: Literal[1]
    project_id: NonEmptyStr
    item_id: NonEmptyStr
    item_type: ItemType | None = None
    preview: DocumentPreview | None
    child_preview: ChildPreview | None = None
    next_actions: Annotated[list[NextAction], Field(max_length=3)] | None = None
    quality: StateQuality | None = None
    last_apply: DocumentChangesResult | None = None

    @classmethod
    def initial(cls, project_id: str, item_id: str, item_type: ItemType | None = None) -> Self:
        """State as the SPA sends it at the start of a thread: no preview."""
        if item_type is None:
            return cls(schema_version=1, project_id=project_id, item_id=item_id, preview=None)
        return cls(schema_version=1, project_id=project_id, item_id=item_id, item_type=item_type, preview=None)


class ForwardedProps(ContractModel):
    """Per-request ``forwardedProps``; MAF drops values above 512 serialized characters."""

    intent: AgentIntent
    child_type: ItemType | None = None

    @model_validator(mode="after")
    def _serialized_length(self) -> Self:
        serialized = json.dumps(self.to_wire(), separators=(",", ":"))
        if len(serialized) > FORWARDED_PROPS_MAX_LENGTH:
            raise ValueError(f"Serialized forwardedProps must not exceed {FORWARDED_PROPS_MAX_LENGTH} characters.")
        return self


class RunErrorCode(StrEnum):
    """Sanitized ``RUN_ERROR`` codes (``contracts/schemas/run-error-codes.schema.json``)."""

    APPROVAL_RESUME_REQUIRED = "APPROVAL_RESUME_REQUIRED"
    APPROVAL_RESUME_NOT_FOUND = "APPROVAL_RESUME_NOT_FOUND"
    APPROVAL_RESUME_INVALID = "APPROVAL_RESUME_INVALID"
    APPROVAL_RESUME_INVALID_RESPONSE = "APPROVAL_RESUME_INVALID_RESPONSE"
    UNAUTHENTICATED = "UNAUTHENTICATED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    THREAD_BUSY = "THREAD_BUSY"
    RATE_LIMITED = "RATE_LIMITED"
    RUN_TIMEOUT = "RUN_TIMEOUT"
    LLM_UNAVAILABLE = "LLM_UNAVAILABLE"
    BACKLOG_UNAVAILABLE = "BACKLOG_UNAVAILABLE"
    TOOL_VALIDATION_FAILED = "TOOL_VALIDATION_FAILED"
    INVALID_REQUEST = "INVALID_REQUEST"
    INTERNAL = "INTERNAL"

    @classmethod
    def normalize(cls, code: object) -> RunErrorCode:
        """Map unknown codes (for example a raw exception class name) to ``INTERNAL``."""
        try:
            return cls(code)
        except ValueError:
            return cls.INTERNAL


#: JSON Schema name (``contracts/schemas/<name>.schema.json``) → model. ``run-error-codes`` maps to the enum.
CONTRACT_MODELS: Final[dict[str, Any]] = {
    "ask-user.args": AskUserArgs,
    "ask-user.result": AskUserResult,
    "propose-document-changes.args": ProposeDocumentChangesArgs,
    "document-changes.result": DocumentChangesResult,
    "propose-child-items.args": ProposeChildItemsArgs,
    "child-items.result": ChildItemsResult,
    "approval-resume": ApprovalResume,
    "resume-entry": ResumeEntry,
    "quality-assessment.args": QualityAssessmentArgs,
    "suggest-next-actions.args": SuggestNextActionsArgs,
    "set-session-title.args": SetSessionTitleArgs,
    "agent-state": AgentState,
    "forwarded-props": ForwardedProps,
    "run-error-codes": RunErrorCode,
}
