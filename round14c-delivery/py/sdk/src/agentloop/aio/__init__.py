"""
Async entry point for AgentLoop.

    from agentloop.aio import AsyncAgentLoop

    async with AsyncAgentLoop(api_key="ak_...") as loop:
        memories = await loop.search("...")
"""

from .._async_client import AsyncAgentLoop

__all__ = ["AsyncAgentLoop"]
