"""
Core helper that wraps a single OpenAI chat-completions call in the
AgentLoop cycle: search → inject → call → log_turn.

Exported as `ask_with_agentloop` for callers who want explicit control.
The `wrap_openai` Proxy in wrap.py builds on top of this.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from agentloop import AgentLoop, Memory

if TYPE_CHECKING:
    from openai import OpenAI


# ---------------------------------------------------------------------------
# Configuration dataclasses
# ---------------------------------------------------------------------------


@dataclass
class PerCallOptions:
    """Per-call overrides passed via the `agentloop` keyword to wrapped calls.

    Every field is optional. A wrapped call with no `agentloop` kwarg at
    all still works — the wrap-time config applies.
    """

    user_id: str | None = None
    session_id: str | None = None
    signals: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    #: Skip AgentLoop entirely — no search, no log_turn. Useful for
    #: health checks, system calls, or any turn you don't want reviewed.
    skip: bool = False
    #: Skip only memory retrieval for this call. Log_turn still fires.
    #: Pass False to disable, or a dict like {"limit": 5, "tags": [...]}
    #: to override defaults.
    search: bool | dict[str, Any] = True


@dataclass
class WrapOptions:
    """Configuration passed to `wrap_openai(client, loop=..., ...)`."""

    loop: AgentLoop

    #: How to inject retrieved memories into the messages array. Default
    #: prepends a "Trusted facts from past corrections:" block to the
    #: first system message (or creates one if absent).
    inject_memories: Callable[[list[Memory], list[dict[str, Any]]], list[dict[str, Any]]] | None = None

    #: Auto-detect signals from the assistant's response. Merged with
    #: any per-call signals the caller passed.
    detect_signals: Callable[[str, str, list[Memory]], dict[str, Any] | None] | None = None

    search_limit: int = 3
    search_tags: list[str] = field(default_factory=list)

    #: If True, log_turn is skipped when no signals fired. Default False
    #: — log every turn so reviewers see baseline behavior.
    only_log_when_signaled: bool = False


# ---------------------------------------------------------------------------
# Default memory injector
# ---------------------------------------------------------------------------


def default_inject_memories(
    memories: list[Memory], messages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Default: append a "Trusted facts" block to the first system message."""
    if not memories:
        return messages

    facts_block = "\n\nTrusted facts from past corrections:\n" + "\n".join(
        f"- {m.fact}" for m in memories
    )

    for i, msg in enumerate(messages):
        if msg.get("role") == "system":
            updated = list(messages)
            existing = msg.get("content", "") or ""
            if isinstance(existing, str):
                updated[i] = {**msg, "content": existing + facts_block}
            return updated

    # No system message — prepend one.
    return [
        {"role": "system", "content": "You are a helpful assistant." + facts_block},
        *messages,
    ]


# ---------------------------------------------------------------------------
# Extract the question from an OpenAI messages array
# ---------------------------------------------------------------------------


def extract_question(messages: list[dict[str, Any]]) -> str:
    """Last user message, text content only."""
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            # Multi-part: concat text parts, skip image parts
            parts = [
                p["text"]
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            return "\n".join(parts)
    return ""


def extract_answer(completion: Any) -> str:
    """Pull text content from a ChatCompletion response object.

    Accesses `.choices[0].message.content` which is the OpenAI SDK's
    object shape. Tolerates missing fields by returning empty string.
    """
    try:
        choices = getattr(completion, "choices", None) or completion.get("choices", [])
        if not choices:
            return ""
        msg = getattr(choices[0], "message", None) or choices[0].get("message", {})
        content = getattr(msg, "content", None) if hasattr(msg, "content") else msg.get("content")
        return content or ""
    except (AttributeError, KeyError, IndexError, TypeError):
        return ""


# ---------------------------------------------------------------------------
# Main entry point — non-streaming
# ---------------------------------------------------------------------------


def ask_with_agentloop(
    client: OpenAI,
    *,
    messages: list[dict[str, Any]],
    per_call: PerCallOptions | None = None,
    config: WrapOptions,
    **create_kwargs: Any,
) -> Any:
    """Run one OpenAI chat-completions call through the full AgentLoop cycle.

    Use this directly if you want explicit control (custom signal
    detection, conditional skipping, non-chat endpoints). The
    `wrap_openai` Proxy builds on top of this for the drop-in case.
    """
    per_call = per_call or PerCallOptions()

    if per_call.skip:
        return client.chat.completions.create(messages=messages, **create_kwargs)

    question = extract_question(messages)

    # ---- 1. Retrieve memories ----
    memories: list[Memory] = []
    if per_call.search is not False and question:
        search_config = per_call.search if isinstance(per_call.search, dict) else {}
        memories = config.loop.search(
            question,
            limit=search_config.get("limit", config.search_limit),
            user_id=per_call.user_id,
            tags=search_config.get("tags") or (config.search_tags or None),
        )

    # ---- 2. Inject memories into prompt ----
    injector = config.inject_memories or default_inject_memories
    augmented_messages = injector(memories, messages)

    # ---- 3. Call the LLM ----
    completion = client.chat.completions.create(
        messages=augmented_messages, **create_kwargs
    )
    answer = extract_answer(completion)

    # ---- 4. Detect signals + log_turn ----
    auto_signals = (
        config.detect_signals(question, answer, memories)
        if config.detect_signals
        else None
    ) or {}
    merged_signals: dict[str, Any] = {**auto_signals, **(per_call.signals or {})}

    should_log = not config.only_log_when_signaled or len(merged_signals) > 0

    if should_log and question and answer:
        config.loop.log_turn(
            question=question,
            agent_response=answer,
            user_id=per_call.user_id,
            session_id=per_call.session_id,
            signals=merged_signals or None,
            metadata=per_call.metadata,
        )

    return completion
