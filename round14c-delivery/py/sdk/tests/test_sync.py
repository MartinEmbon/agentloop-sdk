"""
Tests for the synchronous AgentLoop client.

Uses respx to mock httpx responses. No real network.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from agentloop import (
    AgentLoop,
    AgentLoopError,
    AnnotateResponse,
    LogTurnResponse,
    Memory,
)

BASE = "https://api.example.com"


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_constructor_requires_api_key() -> None:
    with pytest.raises(AgentLoopError):
        AgentLoop(api_key="")


def test_constructor_strips_trailing_slashes() -> None:
    loop = AgentLoop(api_key="ak_test", base_url=f"{BASE}///")
    assert loop.base_url == BASE


def test_base_url_uses_env_var_when_not_provided(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENTLOOP_BASE_URL", "https://env.example.com")
    loop = AgentLoop(api_key="ak_test")
    assert loop.base_url == "https://env.example.com"


def test_explicit_base_url_overrides_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENTLOOP_BASE_URL", "https://env.example.com")
    loop = AgentLoop(api_key="ak_test", base_url="https://explicit.example.com")
    assert loop.base_url == "https://explicit.example.com"


def test_base_url_falls_back_to_cloud_function_when_no_env_and_no_arg(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Ensure the env var is not set; fall-through should hit the hardcoded default.
    monkeypatch.delenv("AGENTLOOP_BASE_URL", raising=False)
    loop = AgentLoop(api_key="ak_test")
    assert "cloudfunctions.net" in loop.base_url


# ---------------------------------------------------------------------------
# search()
# ---------------------------------------------------------------------------


@respx.mock
def test_search_returns_memories_on_success() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "memories": [
                    {
                        "id": "mem_1",
                        "fact": "Pix limit at night is R$1,000.",
                        "score": 0.9,
                        "tags": ["pix"],
                        "source": "ann_1",
                        "created_at": "2026-01-01",
                    }
                ]
            },
        )
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    results = loop.search("pix limit at night", user_id="u_1", limit=5)

    assert len(results) == 1
    assert isinstance(results[0], Memory)
    assert results[0].fact == "Pix limit at night is R$1,000."
    assert results[0].tags == ["pix"]

    # Verify request shape
    assert respx.calls.last.request.headers["Authorization"] == "Bearer ak_test"
    body = respx.calls.last.request.read()
    import json as _json

    sent = _json.loads(body)
    assert sent["query"] == "pix limit at night"
    assert sent["user_id"] == "u_1"
    assert sent["limit"] == 5


@respx.mock
def test_search_degrades_to_empty_on_network_error() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        side_effect=httpx.ConnectError("network down")
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    results = loop.search("q")
    assert results == []


@respx.mock
def test_search_throws_when_throw_on_error_true() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        side_effect=httpx.ConnectError("network down")
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE, throw_on_error=True)
    with pytest.raises(AgentLoopError):
        loop.search("q")


@respx.mock
def test_search_omits_empty_tags() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        return_value=httpx.Response(200, json={"memories": []})
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    loop.search("q", tags=[])

    import json as _json

    sent = _json.loads(respx.calls.last.request.read())
    assert "tags" not in sent


# ---------------------------------------------------------------------------
# log_turn()
# ---------------------------------------------------------------------------


@respx.mock
def test_log_turn_returns_response_with_was_duplicate() -> None:
    respx.post(f"{BASE}/v1/turns").mock(
        return_value=httpx.Response(
            200,
            json={"turn_id": "turn_abc", "status": "pending", "was_duplicate": True},
        )
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    result = loop.log_turn(
        "Q?",
        "A.",
        user_id="u_1",
        signals={"thumbs_down": True},
    )

    assert isinstance(result, LogTurnResponse)
    assert result.turn_id == "turn_abc"
    assert result.was_duplicate is True

    import json as _json

    sent = _json.loads(respx.calls.last.request.read())
    assert sent["question"] == "Q?"
    assert sent["agent_response"] == "A."
    assert sent["signals"] == {"thumbs_down": True}


@respx.mock
def test_log_turn_degrades_on_error() -> None:
    respx.post(f"{BASE}/v1/turns").mock(
        return_value=httpx.Response(500, json={"error": "boom"})
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    result = loop.log_turn("Q?", "A.")
    assert result.turn_id == ""
    assert result.status == "error"


# ---------------------------------------------------------------------------
# annotate() — always throws on error
# ---------------------------------------------------------------------------


def test_annotate_requires_fields() -> None:
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    with pytest.raises(AgentLoopError):
        loop.annotate(
            question="",
            agent_response="A",
            correction="C",
            rating="incorrect",
        )


@respx.mock
def test_annotate_throws_on_http_error() -> None:
    respx.post(f"{BASE}/v1/annotations").mock(
        return_value=httpx.Response(400, json={"error": "bad request"})
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    with pytest.raises(AgentLoopError) as exc_info:
        loop.annotate(
            question="Q",
            agent_response="A",
            correction="C",
            rating="incorrect",
        )
    assert exc_info.value.status == 400


@respx.mock
def test_annotate_returns_response_on_success() -> None:
    respx.post(f"{BASE}/v1/annotations").mock(
        return_value=httpx.Response(
            201,
            json={
                "annotation_id": "ann_1",
                "memory_id": "mem_1",
                "status": "active",
            },
        )
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    result = loop.annotate(
        question="Q",
        agent_response="A",
        correction="C",
        rating="incorrect",
    )
    assert isinstance(result, AnnotateResponse)
    assert result.annotation_id == "ann_1"
    assert result.status == "active"


# ---------------------------------------------------------------------------
# feedback_url() — HMAC byte-match vs JS/Python reference
# ---------------------------------------------------------------------------


def test_feedback_url_requires_signing_secret() -> None:
    loop = AgentLoop(api_key="ak_test", base_url=BASE)
    with pytest.raises(AgentLoopError):
        loop.feedback_url("q", "a")


def test_feedback_url_matches_reference_hmac(monkeypatch: pytest.MonkeyPatch) -> None:
    # Reference: payload = {'q': 'hi', 'a': 'hello', 'u': 'u1', 's': 's1', 't': 1234}
    #            secret  = 'secret'
    # HMAC-SHA256 over json.dumps(payload, sort_keys=True) =
    #   1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a
    #
    # This is the exact signature the JS SDK test also verifies against.
    # Byte-matching across all three implementations.
    EXPECTED = "1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a"

    import agentloop._common as common

    monkeypatch.setattr(common.time, "time", lambda: 1234.5)

    loop = AgentLoop(
        api_key="ak_test", base_url=BASE, feedback_signing_secret="secret"
    )
    url = loop.feedback_url("hi", "hello", user_id="u1", session_id="s1")
    assert f"sig={EXPECTED}" in url


# ---------------------------------------------------------------------------
# AgentLoopError
# ---------------------------------------------------------------------------


@respx.mock
def test_agentloop_error_exposes_status_and_body() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        return_value=httpx.Response(403, json={"error": "Invalid API key"})
    )
    loop = AgentLoop(api_key="ak_test", base_url=BASE, throw_on_error=True)
    with pytest.raises(AgentLoopError) as exc_info:
        loop.search("q")
    assert exc_info.value.status == 403
    assert "Invalid API key" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Context manager
# ---------------------------------------------------------------------------


def test_context_manager_closes_http_client() -> None:
    with AgentLoop(api_key="ak_test", base_url=BASE) as loop:
        assert loop.api_key == "ak_test"
    # After __exit__, the underlying httpx.Client is closed. Best we can
    # do without testing httpx internals is verify close() is idempotent.
    loop.close()
