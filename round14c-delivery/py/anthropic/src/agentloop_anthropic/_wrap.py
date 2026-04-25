"""
wrap_anthropic — drop-in wrapper for an Anthropic client.

Mirrors agentloop_openai.wrap_openai: returns a wrapped client where
`.messages.create()` fires AgentLoop hooks automatically. Every other
namespace passes through unchanged.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentloop import AgentLoop

from ._ask import PerCallOptions, WrapOptions, ask_with_agentloop

if TYPE_CHECKING:
    from anthropic import Anthropic


class _WrappedMessages:
    """Proxy for `client.messages` with a replaced `create` method."""

    def __init__(self, real_messages: Any, config: WrapOptions) -> None:
        self._real = real_messages
        self._config = config

    def create(
        self,
        *,
        agentloop: PerCallOptions | dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        per_call = self._coerce_per_call(agentloop)

        if per_call.skip:
            return self._real.create(**kwargs)

        messages = kwargs.pop("messages", [])
        return ask_with_agentloop(
            _ClientShim(self._real),  # type: ignore[arg-type]
            messages=messages,
            per_call=per_call,
            config=self._config,
            **kwargs,
        )

    @staticmethod
    def _coerce_per_call(
        agentloop: PerCallOptions | dict[str, Any] | None,
    ) -> PerCallOptions:
        if agentloop is None:
            return PerCallOptions()
        if isinstance(agentloop, PerCallOptions):
            return agentloop
        if isinstance(agentloop, dict):
            return PerCallOptions(**agentloop)
        raise TypeError(
            f"agentloop must be PerCallOptions or dict, got {type(agentloop).__name__}"
        )

    def __getattr__(self, name: str) -> Any:
        # count_tokens(), stream(), etc. — pass through unchanged.
        return getattr(self._real, name)


class _ClientShim:
    """Minimal .messages.create holder so ask_with_agentloop can call back
    into the real messages object."""

    def __init__(self, real_messages: Any) -> None:
        self.messages = real_messages


class WrappedAnthropic:
    """Top-level Anthropic proxy. Only `messages` is overridden; every
    other attribute (completions, models, beta, etc.) delegates to the
    original client via __getattr__.
    """

    def __init__(self, client: Anthropic, config: WrapOptions) -> None:
        self._real = client
        self.messages = _WrappedMessages(client.messages, config)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


def wrap_anthropic(
    client: Anthropic,
    *,
    loop: AgentLoop,
    inject_memories: Any = None,
    detect_signals: Any = None,
    search_limit: int = 3,
    search_tags: list[str] | None = None,
    only_log_when_signaled: bool = False,
) -> Anthropic:
    """Wrap an Anthropic client so `messages.create` calls fire AgentLoop
    hooks automatically.

    Example:

        from anthropic import Anthropic
        from agentloop import AgentLoop
        from agentloop_anthropic import wrap_anthropic

        anthropic = wrap_anthropic(
            Anthropic(),
            loop=AgentLoop(api_key="ak_..."),
        )

        msg = anthropic.messages.create(
            model="claude-opus-4-7",
            max_tokens=1024,
            messages=[{"role": "user", "content": "hi"}],
            agentloop={"user_id": "u_123"},
        )
    """
    if not loop:
        raise ValueError("wrap_anthropic: loop is required")

    config = WrapOptions(
        loop=loop,
        inject_memories=inject_memories,
        detect_signals=detect_signals,
        search_limit=search_limit,
        search_tags=search_tags or [],
        only_log_when_signaled=only_log_when_signaled,
    )
    return WrappedAnthropic(client, config)  # type: ignore[return-value]
