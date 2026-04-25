"""
agentloop-anthropic — drop-in Anthropic SDK wrapper for AgentLoop.

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
        messages=[{"role": "user", "content": "hello"}],
        agentloop={"user_id": "u_123"},
    )
"""

from ._ask import PerCallOptions, WrapOptions, ask_with_agentloop
from ._wrap import wrap_anthropic

__all__ = [
    "wrap_anthropic",
    "ask_with_agentloop",
    "PerCallOptions",
    "WrapOptions",
]

__version__ = "0.1.0"
