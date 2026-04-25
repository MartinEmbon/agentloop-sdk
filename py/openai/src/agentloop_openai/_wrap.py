"""
wrap_openai — drop-in wrapper for an OpenAI client.

Returns a wrapped client where `.chat.completions.create()` fires
AgentLoop hooks automatically. Every other namespace (embeddings,
files, audio, etc.) passes through to the original client unchanged.

The original client is NOT mutated — wrap() returns a distinct object.
This matches the Langfuse/Helicone convention and avoids surprises
when both wrapped and unwrapped references exist in the same codebase.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentloop import AgentLoop

from ._ask import PerCallOptions, WrapOptions, ask_with_agentloop

if TYPE_CHECKING:
    from openai import OpenAI


class _WrappedCompletions:
    """Proxy for `client.chat.completions` with a replaced `create` method."""

    def __init__(
        self, real_completions: Any, config: WrapOptions
    ) -> None:
        self._real = real_completions
        self._config = config
        # Pull the underlying client reference from the completions object.
        # OpenAI's SDK structure means completions has an _client attribute
        # but we don't rely on that — ask_with_agentloop takes the client
        # explicitly, so we pass it through the config or a closure.
        # Here we stash it for the wrapped create() to use.
        self._client = getattr(real_completions, "_client", None)

    def create(
        self, *, agentloop: PerCallOptions | dict[str, Any] | None = None, **kwargs: Any
    ) -> Any:
        """Intercepted create. Strips `agentloop` kwarg before forwarding."""
        per_call = self._coerce_per_call(agentloop)

        # If the caller passed skip or there's no client reference, just
        # forward without any hooks.
        if per_call.skip:
            return self._real.create(**kwargs)

        # Need the outer client to re-run create() with augmented messages.
        # We work around the missing _client by delegating back to _real
        # with the same-shaped call. ask_with_agentloop uses
        # client.chat.completions.create — we construct a minimal shim.
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
        # Delegate everything else (create_with_completion, etc.) to the
        # real completions object.
        return getattr(self._real, name)


class _ClientShim:
    """Minimal object with .chat.completions.create — just enough for
    ask_with_agentloop to call back into the underlying real completions.

    We do this instead of trying to reconstruct the whole OpenAI client
    object, which has many fields we don't need to touch.
    """

    def __init__(self, real_completions: Any) -> None:
        self.chat = _ClientShimChat(real_completions)


class _ClientShimChat:
    def __init__(self, real_completions: Any) -> None:
        self.completions = real_completions


class _WrappedChat:
    """Proxy for `client.chat`. Only `.completions` is overridden."""

    def __init__(self, real_chat: Any, config: WrapOptions) -> None:
        self._real = real_chat
        self.completions = _WrappedCompletions(real_chat.completions, config)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


class WrappedOpenAI:
    """Proxy for the full OpenAI client. Delegates everything except
    `chat` through `__getattr__` so embeddings, files, images, etc.
    all pass through unchanged.
    """

    def __init__(self, client: OpenAI, config: WrapOptions) -> None:
        self._real = client
        self.chat = _WrappedChat(client.chat, config)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


def wrap_openai(
    client: OpenAI,
    *,
    loop: AgentLoop,
    inject_memories: Any = None,
    detect_signals: Any = None,
    search_limit: int = 3,
    search_tags: list[str] | None = None,
    only_log_when_signaled: bool = False,
) -> OpenAI:
    """Wrap an OpenAI client so `chat.completions.create` calls fire
    AgentLoop hooks automatically.

    The return value is typed as OpenAI for drop-in compatibility. The
    only observable difference: create() accepts an extra `agentloop`
    kwarg for per-call overrides.

    Example:

        from openai import OpenAI
        from agentloop import AgentLoop
        from agentloop_openai import wrap_openai

        openai = wrap_openai(
            OpenAI(),
            loop=AgentLoop(api_key="ak_..."),
        )

        resp = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "hi"}],
            agentloop={"user_id": "u_123"},  # per-call override
        )
    """
    if not loop:
        raise ValueError("wrap_openai: loop is required")

    config = WrapOptions(
        loop=loop,
        inject_memories=inject_memories,
        detect_signals=detect_signals,
        search_limit=search_limit,
        search_tags=search_tags or [],
        only_log_when_signaled=only_log_when_signaled,
    )
    return WrappedOpenAI(client, config)  # type: ignore[return-value]
