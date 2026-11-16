"""OpenAI-compatible chat client factory (LLM gateway).

``AGENT_LLM_BASE_URL`` is the gateway *base* URL; the MAF clients expect it to end with ``/v1`` (they append
``/chat/completions`` or ``/responses``), so ``/v1`` is appended when missing. ``AGENT_LLM_API`` selects the wire API:

* ``chat`` (default): ``OpenAIChatCompletionClient`` -> ``POST /v1/chat/completions``
* ``responses``: ``OpenAIChatClient`` (the *Responses* client despite its name) -> ``POST /v1/responses``

Credentials: ``AGENT_LLM_API_KEY`` (secret, optional). The OpenAI SDK insists on a key, so a placeholder is used
when none is configured (gateways that authenticate by network identity ignore it).
"""

from __future__ import annotations

from typing import Any, cast

from agent_framework import SupportsChatGetResponse
from agent_framework.openai import OpenAIChatClient, OpenAIChatCompletionClient

from agent_service.settings import Settings

PLACEHOLDER_API_KEY = "not-configured"

ChatClient = SupportsChatGetResponse[Any]


def normalize_base_url(base_url: str) -> str:
    """``https://gw`` or ``https://gw/`` -> ``https://gw/v1``; an existing ``/v1`` suffix is kept."""
    base = base_url.strip().rstrip("/")
    if not base:
        raise ValueError("The LLM base URL is empty.")
    return base if base.endswith("/v1") else f"{base}/v1"


def api_key_value(settings: Settings) -> str:
    return settings.llm_api_key.get_secret_value() if settings.llm_api_key else PLACEHOLDER_API_KEY


def create_chat_client(settings: Settings, *, model: str | None = None, **options: Any) -> ChatClient:
    """Create the chat client for ``settings.llm_api``; ``model`` overrides the default alias (agent definitions)."""
    if not settings.llm_base_url:
        raise RuntimeError("AGENT_LLM_BASE_URL is not configured.")
    kwargs: dict[str, Any] = {
        "model": model or settings.llm_model,
        "base_url": normalize_base_url(settings.llm_base_url),
        "api_key": api_key_value(settings),
        **options,
    }
    if settings.llm_api == "responses":
        return cast(ChatClient, OpenAIChatClient(**kwargs))
    return cast(ChatClient, OpenAIChatCompletionClient(**kwargs))
