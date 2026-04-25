"""
Tests for AsyncAgentLoop. Mirrors tests/test_sync.py but async.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from agentloop import AgentLoopError, LogTurnResponse, Memory
from agentloop.aio import AsyncAgentLoop

BASE = "https://api.example.com"


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


async def test_async_constructor_requires_api_key() -> None:
    with pytest.raises(AgentLoopError):
        AsyncAgentLoop(api_key="")


# ---------------------------------------------------------------------------
# search()
# ---------------------------------------------------------------------------


@respx.mock
async def test_async_search_returns_memories() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "memories": [
                    {
                        "id": "mem_1",
                        "fact": "test fact",
                        "score": 0.9,
                        "tags": [],
                        "source": "ann_1",
                        "created_at": "2026-01-01",
                    }
                ]
            },
        )
    )
    async with AsyncAgentLoop(api_key="ak_test", base_url=BASE) as loop:
        results = await loop.search("hello")
    assert len(results) == 1
    assert isinstance(results[0], Memory)
    assert results[0].fact == "test fact"


@respx.mock
async def test_async_search_degrades_to_empty() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        side_effect=httpx.ConnectError("down")
    )
    async with AsyncAgentLoop(api_key="ak_test", base_url=BASE) as loop:
        results = await loop.search("q")
    assert results == []


@respx.mock
async def test_async_search_throws_on_error_when_configured() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        side_effect=httpx.ConnectError("down")
    )
    async with AsyncAgentLoop(
        api_key="ak_test", base_url=BASE, throw_on_error=True
    ) as loop:
        with pytest.raises(AgentLoopError):
            await loop.search("q")


# ---------------------------------------------------------------------------
# log_turn()
# ---------------------------------------------------------------------------


@respx.mock
async def test_async_log_turn_returns_was_duplicate() -> None:
    respx.post(f"{BASE}/v1/turns").mock(
        return_value=httpx.Response(
            200,
            json={"turn_id": "turn_x", "status": "pending", "was_duplicate": True},
        )
    )
    async with AsyncAgentLoop(api_key="ak_test", base_url=BASE) as loop:
        result = await loop.log_turn("Q?", "A.")
    assert isinstance(result, LogTurnResponse)
    assert result.was_duplicate is True


# ---------------------------------------------------------------------------
# annotate() always throws on failure
# ---------------------------------------------------------------------------


@respx.mock
async def test_async_annotate_throws_on_error() -> None:
    respx.post(f"{BASE}/v1/annotations").mock(
        return_value=httpx.Response(400, json={"error": "bad"})
    )
    async with AsyncAgentLoop(api_key="ak_test", base_url=BASE) as loop:
        with pytest.raises(AgentLoopError):
            await loop.annotate(
                question="Q",
                agent_response="A",
                correction="C",
                rating="incorrect",
            )


async def test_async_annotate_validates_required_fields() -> None:
    async with AsyncAgentLoop(api_key="ak_test", base_url=BASE) as loop:
        with pytest.raises(AgentLoopError):
            await loop.annotate(
                question="",
                agent_response="A",
                correction="C",
                rating="incorrect",
            )


# ---------------------------------------------------------------------------
# feedback_url() — sync method on async client. HMAC still matches.
# ---------------------------------------------------------------------------


async def test_async_feedback_url_is_sync_and_matches_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    EXPECTED = "1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a"
    import agentloop._common as common

    monkeypatch.setattr(common.time, "time", lambda: 1234.5)

    async with AsyncAgentLoop(
        api_key="ak_test", base_url=BASE, feedback_signing_secret="secret"
    ) as loop:
        # Note: NOT awaited — feedback_url is sync even on the async client.
        url = loop.feedback_url("hi", "hello", user_id="u1", session_id="s1")
    assert f"sig={EXPECTED}" in url


# ---------------------------------------------------------------------------
# Context manager
# ---------------------------------------------------------------------------


async def test_async_context_manager_closes_client() -> None:
    async with AsyncAgentLoop(api_key="ak_test", base_url=BASE) as loop:
        assert loop.api_key == "ak_test"
    # aclose should be idempotent
    await loop.aclose()
