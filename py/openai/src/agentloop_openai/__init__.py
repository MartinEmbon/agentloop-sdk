"""
agentloop-py-openai — drop-in OpenAI SDK wrapper for AgentLoop.

    from openai import OpenAI
    from agentloop import AgentLoop
    from agentloop_openai import wrap_openai

    openai = wrap_openai(
        OpenAI(),
        loop=AgentLoop(api_key="ak_..."),
    )

    # Unchanged OpenAI call — AgentLoop hooks fire automatically
    resp = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hello"}],
        agentloop={"user_id": "u_123"},
    )
"""

from ._ask import PerCallOptions, WrapOptions, ask_with_agentloop
from ._wrap import wrap_openai

__all__ = [
    "wrap_openai",
    "ask_with_agentloop",
    "PerCallOptions",
    "WrapOptions",
]

__version__ = "0.1.0"
