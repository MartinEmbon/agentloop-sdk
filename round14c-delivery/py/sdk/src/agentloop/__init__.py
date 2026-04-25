"""
AgentLoop — Python SDK.

Middleware that turns human corrections into searchable memory for
your agent. Call search() before your LLM call, log_turn() after.

Sync usage:

    from agentloop import AgentLoop

    loop = AgentLoop(api_key="ak_...")
    memories = loop.search("what's the pix limit?")
    loop.log_turn(question, answer, user_id="u_123")

Async usage:

    from agentloop.aio import AsyncAgentLoop

    async with AsyncAgentLoop(api_key="ak_...") as loop:
        memories = await loop.search("...")
        await loop.log_turn(...)
"""

from ._client import AgentLoop
from .types import (
    AgentLoopError,
    AnnotateResponse,
    LogTurnResponse,
    Memory,
    Rating,
    RootCause,
)

__all__ = [
    "AgentLoop",
    "AgentLoopError",
    "AnnotateResponse",
    "LogTurnResponse",
    "Memory",
    "Rating",
    "RootCause",
]

__version__ = "0.1.2"
