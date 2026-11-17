"""``propose_document_changes`` and ``propose_child_items``: proposal -> user review -> apply (plan §6.2 / §6.5).

Both tools require approval. While the model streams the arguments, MAF's predictive state fills ``state.preview`` /
``state.childPreview`` with the full arguments object (``predict_state`` of the agent definition, ``argument: "*"``).
The run then ends with an interrupt; the user accepts, edits (``editedArgs``, a FULL replacement of the arguments) or
rejects per section / child. After approval the tool runs with the *returned* arguments:

1. they are validated again (MAF hands over plain dicts),
2. the model's original proposal is loaded (:func:`~agent_service.tools.runtime.original_arguments`) and the returned
   arguments must be a subset of it (unknown ids, a different ``baseVersion``/``childType``/heading/mode, new
   relationships are errors; nothing is applied),
3. each accepted section / child is classified as unchanged (``applied``), changed by the user (``edited``) or left
   out (``rejected``),
4. the accepted subset is written through the hidden MCP write tool with the user's own token,
5. the shared state is updated (``preview``/``childPreview`` cleared, ``lastApply`` = the result plus the proposal's
   ``toolCallId`` and ``at``) and the model gets the result JSON (``document-changes.result`` / ``child-items.result``).

A rejected proposal never reaches the tool (MAF answers ``Error: Tool call invocation was rejected by user.``); the
runner clears the previews for it (:class:`~agent_service.agents.runner.StepEmittingRunner`).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any

from agent_framework import FunctionInvocationContext, tool
from agent_framework_ag_ui import state_update
from backlog_contracts import (
    ChildItemsResult,
    ChildLastApply,
    CreatedChild,
    DocumentChangesResult,
    DocumentLastApply,
    FailedChild,
    ProposeChildItemsArgs,
    ProposeDocumentChangesArgs,
    SectionConflict,
    SkippedRelationship,
)

from agent_service.agents.providers import ITEM_CONTEXT_CACHE_KEY
from agent_service.mcp_client import McpToolError, current_mcp, current_run_scope
from agent_service.tools import ToolRegistry
from agent_service.tools.guard import ToolInputError, guarded, validate_arguments
from agent_service.tools.runtime import apply_stamp, item_ids, original_arguments, run_id, tool_schema

logger = logging.getLogger(__name__)

PROPOSE_DOCUMENT_CHANGES = "propose_document_changes"
PROPOSE_CHILD_ITEMS = "propose_child_items"
PREVIEW_CLEARED = {"preview": None}
CHILD_PREVIEW_CLEARED = {"childPreview": None}
REJECTED_REF_REASON = "a related child was rejected in the review"
REMOVED_REF_REASON = "removed by the user in the review"
NOT_APPLIED_PREFIX = "Error: nothing was changed. "


def _compact(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _mcp_failure(tool_name: str, exc: McpToolError, state: Mapping[str, Any]) -> Any:
    logger.warning("MCP write tool failed", extra={"tool": tool_name, "status": exc.status, "type": exc.type})
    return state_update(
        text=f"Error: {tool_name} could not be applied ({exc.type}: {exc.detail}). Nothing was changed; tell the user.",
        state=dict(state),
    )


def _by_key(items: Any, key: str) -> dict[str, dict[str, Any]]:
    """``{item[key]: item}`` of a raw list of dicts (the original proposal is read leniently)."""
    if not isinstance(items, list):
        return {}
    return {str(item[key]): item for item in items if isinstance(item, dict) and isinstance(item.get(key), str)}


# --- propose_document_changes -------------------------------------------------------------------------------------


def check_document_edits(edited: ProposeDocumentChangesArgs, original: Mapping[str, Any]) -> None:
    """Edited arguments must be a subset of the proposal; only the Markdown of a section may change."""
    if original.get("baseVersion") != edited.base_version:
        raise ToolInputError("baseVersion must not be changed in the review")
    for name, value in (("suggestedTitle", edited.suggested_title), ("suggestedStatus", edited.suggested_status)):
        if value is not None and value != original.get(name):
            raise ToolInputError(f"{name} must not be changed in the review")
    originals = _by_key(original.get("sections"), "id")
    for section in edited.sections:
        proposed = originals.get(section.id)
        if proposed is None:
            raise ToolInputError(f"section '{section.id}' is not part of the proposal")
        if section.heading != proposed.get("heading") or section.mode != proposed.get("mode", "replace"):
            raise ToolInputError(f"only the Markdown of section '{section.id}' may be edited, not its heading or mode")


async def propose_document_changes_impl(ctx: FunctionInvocationContext, arguments: Mapping[str, Any]) -> Any:
    edited = validate_arguments(ProposeDocumentChangesArgs, arguments)
    original = await original_arguments(ctx)
    check_document_edits(edited, original)
    project_id, item_id = item_ids(ctx)

    originals = _by_key(original.get("sections"), "id")
    accepted_ids = [section.id for section in edited.sections]
    rejected = [section_id for section_id in originals if section_id not in accepted_ids]
    changed = {s.id for s in edited.sections if s.markdown != originals[s.id].get("markdown")}

    try:
        outcome = await current_mcp().call(
            "apply_document_changes",
            projectId=project_id,
            itemId=item_id,
            baseVersion=edited.base_version,
            sections=[
                {"id": s.id, "heading": s.heading, "mode": s.mode, "markdown": s.markdown} for s in edited.sections
            ],
            suggestedTitle=edited.suggested_title,
            suggestedStatus=edited.suggested_status,
            runId=run_id(ctx),
        )
    except McpToolError as exc:
        return _mcp_failure(PROPOSE_DOCUMENT_CHANGES, exc, PREVIEW_CLEARED)

    conflicts = [SectionConflict.model_validate(conflict) for conflict in outcome.get("conflicted") or []]
    applied_by_backlog = {str(section_id) for section_id in outcome.get("applied") or []}
    warnings = [str(warning) for warning in outcome.get("warnings") or []]
    missing = [
        section_id
        for section_id in accepted_ids
        if section_id not in applied_by_backlog and section_id not in {c.section_id for c in conflicts}
    ]
    warnings += [f"Section '{section_id}' was not applied." for section_id in missing]
    result = DocumentChangesResult(
        applied=[i for i in accepted_ids if i in applied_by_backlog and i not in changed],
        edited=[i for i in accepted_ids if i in applied_by_backlog and i in changed],
        rejected=rejected,
        conflicted=conflicts,
        new_version=int(outcome.get("newVersion", edited.base_version)),
        warnings=warnings,
        title_applied=bool(outcome.get("titleApplied", False)),
        status_applied=bool(outcome.get("statusApplied", False)),
    )
    if applied_by_backlog or result.title_applied or result.status_applied:
        _forget_item_context()
    wire = result.to_wire()
    last_apply = DocumentLastApply.model_validate({**wire, **apply_stamp(ctx)}).to_wire()
    return state_update(text=_compact(wire), state={**PREVIEW_CLEARED, "lastApply": last_apply})


def _forget_item_context() -> None:
    """The item changed: drop the run's cached ``get_item_context`` (its version and document hash are outdated)."""
    scope = current_run_scope()
    if scope is not None:
        scope.cache.pop(ITEM_CONTEXT_CACHE_KEY, None)


# --- propose_child_items ------------------------------------------------------------------------------------------


def _relationship_key(relationship: Mapping[str, Any]) -> tuple[Any, Any, Any]:
    return relationship.get("sourceRef"), relationship.get("targetRef"), relationship.get("type")


def check_child_edits(edited: ProposeChildItemsArgs, original: Mapping[str, Any]) -> None:
    """Edited arguments must be a subset of the proposal; only titles and Markdown of children may change."""
    if original.get("childType") != edited.child_type:
        raise ToolInputError("childType must not be changed in the review")
    originals = _by_key(original.get("children"), "proposalId")
    for child in edited.children:
        if child.proposal_id not in originals:
            raise ToolInputError(f"child '{child.proposal_id}' is not part of the proposal")
    proposed = {_relationship_key(r) for r in original.get("relationships") or [] if isinstance(r, dict)}
    for relationship in edited.relationships or []:
        if (relationship.source_ref, relationship.target_ref, relationship.type) not in proposed:
            raise ToolInputError(
                f"relationship {relationship.source_ref} -> {relationship.target_ref} is not part of the proposal"
            )


async def propose_child_items_impl(ctx: FunctionInvocationContext, arguments: Mapping[str, Any]) -> Any:
    edited = validate_arguments(ProposeChildItemsArgs, arguments)
    original = await original_arguments(ctx)
    check_child_edits(edited, original)
    project_id, parent_id = item_ids(ctx)

    originals = _by_key(original.get("children"), "proposalId")
    accepted_ids = [child.proposal_id for child in edited.children]
    rejected = [proposal_id for proposal_id in originals if proposal_id not in accepted_ids]
    changed = {
        c.proposal_id
        for c in edited.children
        if (c.title, c.markdown) != (originals[c.proposal_id].get("title"), originals[c.proposal_id].get("markdown"))
    }

    kept_by_user = {(r.source_ref, r.target_ref, r.type) for r in edited.relationships or []}
    kept: list[dict[str, str]] = []
    skipped: list[SkippedRelationship] = []
    for proposed in original.get("relationships") or []:
        if not isinstance(proposed, dict):
            continue
        source, target, kind = (str(proposed.get(k)) for k in ("sourceRef", "targetRef", "type"))
        if source in rejected or target in rejected:
            skipped.append(SkippedRelationship(source_ref=source, target_ref=target, reason=REJECTED_REF_REASON))
        elif (source, target, kind) in kept_by_user:
            kept.append({"sourceRef": source, "targetRef": target, "type": kind})
        else:
            skipped.append(SkippedRelationship(source_ref=source, target_ref=target, reason=REMOVED_REF_REASON))

    try:
        outcome = await current_mcp().call(
            "create_child_items",
            projectId=project_id,
            parentId=parent_id,
            childType=edited.child_type,
            children=[{"proposalId": c.proposal_id, "title": c.title, "markdown": c.markdown} for c in edited.children],
            relationships=kept or None,
            runId=run_id(ctx),
        )
    except McpToolError as exc:
        return _mcp_failure(PROPOSE_CHILD_ITEMS, exc, CHILD_PREVIEW_CLEARED)

    created = [CreatedChild.model_validate(child) for child in outcome.get("created") or []]
    failed = [FailedChild.model_validate(child) for child in outcome.get("failed") or []]
    skipped += [SkippedRelationship.model_validate(item) for item in outcome.get("relationshipsSkipped") or []]
    created_ids = {child.proposal_id for child in created}
    result = ChildItemsResult(
        created=created,
        edited=[i for i in accepted_ids if i in created_ids and i in changed],
        rejected=rejected,
        failed=failed,
        relationships_created=int(outcome.get("relationshipsCreated", 0)),
        relationships_skipped=skipped,
    )
    wire = result.to_wire()
    last_apply = ChildLastApply.model_validate({**wire, **apply_stamp(ctx)}).to_wire()
    return state_update(text=_compact(wire), state={**CHILD_PREVIEW_CLEARED, "lastApply": last_apply})


# --- registration -------------------------------------------------------------------------------------------------


def _document_tool() -> Any:
    description, parameters = tool_schema("propose-document-changes")

    @tool(name=PROPOSE_DOCUMENT_CHANGES, description=description, schema=parameters, approval_mode="always_require")
    async def propose_document_changes(ctx: FunctionInvocationContext, **arguments: Any) -> Any:
        return await guarded(PROPOSE_DOCUMENT_CHANGES, PREVIEW_CLEARED, propose_document_changes_impl(ctx, arguments))

    return propose_document_changes


def _child_tool() -> Any:
    description, parameters = tool_schema("propose-child-items")

    @tool(name=PROPOSE_CHILD_ITEMS, description=description, schema=parameters, approval_mode="always_require")
    async def propose_child_items(ctx: FunctionInvocationContext, **arguments: Any) -> Any:
        return await guarded(PROPOSE_CHILD_ITEMS, CHILD_PREVIEW_CLEARED, propose_child_items_impl(ctx, arguments))

    return propose_child_items


def register(registry: ToolRegistry) -> None:
    registry.register(
        PROPOSE_DOCUMENT_CHANGES,
        _document_tool,
        arguments=ProposeDocumentChangesArgs,
        error_state=PREVIEW_CLEARED,
    )
    registry.register(
        PROPOSE_CHILD_ITEMS, _child_tool, arguments=ProposeChildItemsArgs, error_state=CHILD_PREVIEW_CLEARED
    )
