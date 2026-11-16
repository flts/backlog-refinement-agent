"""PLACEHOLDER agent tools, to be replaced by ``svc-tools``.

They carry the final names, descriptions and argument schemas (``backlog_contracts``) so the model sees the real tool
surface, but they do not touch the backlog: the ``propose_*`` and ``record_quality_assessment`` placeholders answer
that the tool is not implemented yet, and ``suggest_next_actions`` / ``set_session_title`` only acknowledge. Nothing is
ever applied. ``svc-tools`` registers real implementations under the same names (``registry.register(...,
replace=True)`` or by removing this module from :func:`agent_service.tools.default_tool_registry`).
"""

from __future__ import annotations

from typing import Any

from agent_framework import FunctionTool, tool
from backlog_contracts import (
    ProposeChildItemsArgs,
    ProposeDocumentChangesArgs,
    QualityAssessmentArgs,
    SetSessionTitleArgs,
    SuggestNextActionsArgs,
)

from agent_service.tools import ToolRegistry

NOT_IMPLEMENTED = (
    "Error: this tool is not available yet; nothing was changed. Describe the change in your reply instead."
)


def _placeholder(name: str, description: str, schema: type[Any], *, approval: str, reply: str) -> FunctionTool:
    @tool(name=name, description=description, schema=schema, approval_mode=approval)  # type: ignore[arg-type]
    async def placeholder(**_arguments: Any) -> str:
        return reply

    return placeholder


def register(registry: ToolRegistry) -> None:
    registry.register(
        "propose_document_changes",
        lambda: _placeholder(
            "propose_document_changes",
            "Propose changes to sections of the current item's document for the user to review. Use the version from "
            "get_item_context as baseVersion. Never output the document as JSON in your reply.",
            ProposeDocumentChangesArgs,
            approval="always_require",
            reply=NOT_IMPLEMENTED,
        ),
    )
    registry.register(
        "propose_child_items",
        lambda: _placeholder(
            "propose_child_items",
            "Propose child items (each a complete Markdown document that follows the template of the child type) for "
            "the user to review.",
            ProposeChildItemsArgs,
            approval="always_require",
            reply=NOT_IMPLEMENTED,
        ),
    )
    registry.register(
        "record_quality_assessment",
        lambda: _placeholder(
            "record_quality_assessment",
            "Record the quality assessment of the current document (no rewrite, no questions).",
            QualityAssessmentArgs,
            approval="never_require",
            reply=NOT_IMPLEMENTED,
        ),
    )
    registry.register(
        "suggest_next_actions",
        lambda: _placeholder(
            "suggest_next_actions",
            "Offer the user up to three follow-up actions as buttons. Call it at the end of a turn.",
            SuggestNextActionsArgs,
            approval="never_require",
            reply="ok",
        ),
    )
    registry.register(
        "set_session_title",
        lambda: _placeholder(
            "set_session_title",
            "Give this conversation a short descriptive title (at most 60 characters). Call it early, once.",
            SetSessionTitleArgs,
            approval="never_require",
            reply="ok",
        ),
    )
