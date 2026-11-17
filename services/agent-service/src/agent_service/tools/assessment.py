"""``record_quality_assessment``: store the assessment of the current document and mirror it into ``state.quality``.

The document hash always comes from the run's ``get_item_context`` result (cached by the ``item_context`` provider),
not from the model: what the assessment is stored against is what the run read. A ``documentHash`` the model passes is
only used when the cache is gone (after an approved change or a stale answer the cache is dropped and the model must
have re-read the item). The backlog answers ``stale-assessment`` when the document changed in the meantime.
"""

from __future__ import annotations

import logging
from typing import Any

from agent_framework import FunctionInvocationContext, tool
from agent_framework_ag_ui import state_update
from backlog_contracts import QualityAssessmentArgs, StateQuality

from agent_service.agents.providers import ITEM_CONTEXT_CACHE_KEY
from agent_service.mcp_client import McpToolError, current_mcp, current_run_scope
from agent_service.tools import ToolRegistry
from agent_service.tools.guard import ToolInputError, guarded, validate_arguments
from agent_service.tools.runtime import item_ids, tool_schema

logger = logging.getLogger(__name__)

RECORD_QUALITY_ASSESSMENT = "record_quality_assessment"
STALE_TYPE = "stale-assessment"


def _cached_hash() -> str | None:
    scope = current_run_scope()
    context = scope.cache.get(ITEM_CONTEXT_CACHE_KEY) if scope is not None else None
    item = context.get("item") if isinstance(context, dict) else None
    value = item.get("documentHash") if isinstance(item, dict) else None
    return value if isinstance(value, str) and value else None


async def record_quality_assessment_impl(ctx: FunctionInvocationContext, arguments: dict[str, Any]) -> Any:
    args = validate_arguments(QualityAssessmentArgs, arguments)
    document_hash = _cached_hash() or args.document_hash
    if document_hash is None:
        raise ToolInputError("documentHash is required: call get_item_context and pass item.documentHash")
    project_id, item_id = item_ids(ctx)
    quality = args.to_wire()
    quality.pop("documentHash", None)
    try:
        stored = await current_mcp().call(
            "set_item_quality",
            projectId=project_id,
            itemId=item_id,
            quality=quality,
            documentHash=document_hash,
        )
    except McpToolError as exc:
        if exc.type == STALE_TYPE:
            scope = current_run_scope()
            if scope is not None:
                scope.cache.pop(ITEM_CONTEXT_CACHE_KEY, None)
            return (
                "Error: the document changed since you read it, so the assessment was not stored (stale-assessment). "
                "Call get_item_context, assess the current document again and call record_quality_assessment with "
                "the new documentHash."
            )
        logger.warning("set_item_quality failed", extra={"status": exc.status, "type": exc.type})
        return f"Error: the assessment could not be stored ({exc.type}: {exc.detail}). Tell the user."
    mirrored = {**quality, "documentHash": stored.get("documentHash") or document_hash}
    if stored.get("assessedAt"):
        mirrored["assessedAt"] = stored["assessedAt"]
    state = StateQuality.model_validate(mirrored)
    return state_update(text="ok: the assessment was stored.", state={"quality": state.to_wire()})


def _tool() -> Any:
    description, parameters = tool_schema("quality-assessment")

    @tool(name=RECORD_QUALITY_ASSESSMENT, description=description, schema=parameters, approval_mode="never_require")
    async def record_quality_assessment(ctx: FunctionInvocationContext, **arguments: Any) -> Any:
        return await guarded(RECORD_QUALITY_ASSESSMENT, None, record_quality_assessment_impl(ctx, arguments))

    return record_quality_assessment


def register(registry: ToolRegistry) -> None:
    registry.register(RECORD_QUALITY_ASSESSMENT, _tool, arguments=QualityAssessmentArgs)
