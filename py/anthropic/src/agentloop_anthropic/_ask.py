"""
Core helper for the Anthropic wrapper.

Anthropic's API differs from OpenAI:
- system prompt lives on a top-level `system` field, not a message role
- response.content is a list of blocks (text / tool_use / etc.)
- text extraction requires filter+map

AgentLoop semantics are identical.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Union

from agentloop import AgentLoop, Memory

if TYPE_CHECKING:
    from anthropic import Anthropic


SystemPrompt = Union[str, list[dict[str, Any]], None]


# ---------------------------------------------------------------------------
# Configuration dataclasses
# ---------------------------------------------------------------------------


@dataclass
class PerCallOptions:
    """Per-call overrides passed via the `agentloop` kwarg."""

    user_id: str | None = None
    session_id: str | None = None
    signals: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    skip: bool = False
    search: bool | dict[str, Any] = True


@dataclass
class WrapOptions:
    loop: AgentLoop
    inject_memories: (
        Callable[[list[Memory], SystemPrompt], SystemPrompt] | None
    ) = None
    detect_signals: (
        Callable[[str, str, list[Memory]], dict[str, Any] | None] | None
    ) = None
    search_limit: int = 3
    search_tags: list[str] = field(default_factory=list)
    only_log_when_signaled: bool = False


# ---------------------------------------------------------------------------
# Default memory injector
# ---------------------------------------------------------------------------


def default_inject_memories(
    memories: list[Memory], existing_system: SystemPrompt
) -> SystemPrompt:
    """Append a 'Trusted facts' block to the existing system prompt.

    Handles string form (simple concat) and array-of-text-blocks form
    (append to the last text block, or add a new one).
    """
    if not memories:
        return existing_system

    facts_block = "\n\nTrusted facts from past corrections:\n" + "\n".join(
        f"- {m.fact}" for m in memories
    )

    if existing_system is None:
        return "You are a helpful assistant." + facts_block

    if isinstance(existing_system, str):
        return existing_system + facts_block

    # Array form — append to last text block or add one
    updated = list(existing_system)
    for i in range(len(updated) - 1, -1, -1):
        block = updated[i]
        if isinstance(block, dict) and block.get("type") == "text":
            updated[i] = {**block, "text": block.get("text", "") + facts_block}
            return updated
    updated.append({"type": "text", "text": facts_block})
    return updated


# ---------------------------------------------------------------------------
# Extract question / answer
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
            parts = [
                p["text"]
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            return "\n".join(parts)
    return ""


def extract_answer(message: Any) -> str:
    """Concatenate text blocks from an Anthropic Message response."""
    try:
        content = getattr(message, "content", None)
        if content is None:
            return ""
        parts: list[str] = []
        for block in content:
            block_type = (
                getattr(block, "type", None)
                if hasattr(block, "type")
                else block.get("type") if isinstance(block, dict) else None
            )
            if block_type == "text":
                text = (
                    getattr(block, "text", "")
                    if hasattr(block, "text")
                    else block.get("text", "") if isinstance(block, dict) else ""
                )
                if text:
                    parts.append(text)
        return "".join(parts)
    except (AttributeError, KeyError, TypeError):
        return ""


# ---------------------------------------------------------------------------
# Main entry point (non-streaming)
# ---------------------------------------------------------------------------


def ask_with_agentloop(
    client: Anthropic,
    *,
    messages: list[dict[str, Any]],
    per_call: PerCallOptions | None = None,
    config: WrapOptions,
    **create_kwargs: Any,
) -> Any:
    """Run one Anthropic messages.create call through the AgentLoop cycle."""
    per_call = per_call or PerCallOptions()

    if per_call.skip:
        return client.messages.create(messages=messages, **create_kwargs)

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

    # ---- 2. Inject memories into system prompt ----
    injector = config.inject_memories or default_inject_memories
    existing_system = create_kwargs.pop("system", None)
    new_system = injector(memories, existing_system)

    kwargs: dict[str, Any] = dict(create_kwargs)
    if new_system is not None:
        kwargs["system"] = new_system

    # ---- 3. Call Anthropic ----
    message = client.messages.create(messages=messages, **kwargs)
    answer = extract_answer(message)

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

    return message
