"""
Tests for agentloop-anthropic.

Fake Anthropic client + respx for the AgentLoop backend.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import respx

from agentloop import AgentLoop
from agentloop_anthropic import PerCallOptions, ask_with_agentloop, wrap_anthropic

BASE = "https://api.example.com"


# ---------------------------------------------------------------------------
# Fake Anthropic
# ---------------------------------------------------------------------------


@dataclass
class FakeTextBlock:
    text: str
    type: str = "text"


@dataclass
class FakeMessage:
    content: list[FakeTextBlock]
    id: str = "msg_fake"
    role: str = "assistant"
    model: str = "claude-opus-4-7"
    stop_reason: str = "end_turn"
    usage: dict[str, int] = field(default_factory=lambda: {"input_tokens": 10, "output_tokens": 20})


class FakeMessages:
    def __init__(self, handler: Any) -> None:
        self._handler = handler
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self._handler(kwargs)


class FakeModels:
    """Sibling namespace — should pass through unchanged."""

    def list(self) -> Any:
        return {"data": [{"id": "claude-opus-4-7"}]}


class FakeAnthropic:
    def __init__(self, handler: Any) -> None:
        self._messages = FakeMessages(handler)
        self.messages = self._messages
        self.models = FakeModels()

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self._messages.calls


def make_message(text: str) -> FakeMessage:
    return FakeMessage(content=[FakeTextBlock(text=text)])


# ---------------------------------------------------------------------------
# Backend helpers
# ---------------------------------------------------------------------------


def register_backend() -> None:
    respx.post(f"{BASE}/v1/memories/search").mock(
        side_effect=lambda req: httpx.Response(
            200,
            json={
                "memories": [
                    {
                        "id": "mem_1",
                        "fact": f"Fact relevant to: {json.loads(req.content).get('query', '')}",
                        "score": 0.9,
                        "tags": [],
                        "source": "ann_1",
                        "created_at": "2026-01-01",
                    }
                ]
            },
        )
    )
    respx.post(f"{BASE}/v1/turns").mock(
        return_value=httpx.Response(
            201,
            json={"turn_id": "turn_fake", "status": "pending", "was_duplicate": False},
        )
    )


def make_loop() -> AgentLoop:
    return AgentLoop(api_key="ak_test", base_url=BASE)


def backend_calls_for(path: str) -> list[httpx.Request]:
    return [c.request for c in respx.calls if path in str(c.request.url)]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_wrap_anthropic_requires_loop() -> None:
    fake = FakeAnthropic(lambda _: make_message("x"))
    with pytest.raises((ValueError, TypeError)):
        wrap_anthropic(fake, loop=None)  # type: ignore[arg-type]


@respx.mock
def test_basic_pre_post_hooks_fire() -> None:
    register_backend()
    fake = FakeAnthropic(lambda _: make_message("claude reply"))
    wrapped = wrap_anthropic(fake, loop=make_loop())

    resp = wrapped.messages.create(
        model="claude-opus-4-7",
        max_tokens=100,
        messages=[{"role": "user", "content": "what is the pix limit?"}],
    )

    # Response preserved
    assert resp.content[0].text == "claude reply"

    search = backend_calls_for("/v1/memories/search")
    assert len(search) == 1
    body = json.loads(search[0].content)
    assert body["query"] == "what is the pix limit?"

    # Memory injected into system prompt (was None, default injector
    # creates "You are a helpful assistant." + facts block)
    sent = fake.calls[0]
    assert isinstance(sent["system"], str)
    assert "Fact relevant to: what is the pix limit?" in sent["system"]

    # log_turn fired
    logs = backend_calls_for("/v1/turns")
    assert len(logs) == 1
    log_body = json.loads(logs[0].content)
    assert log_body["question"] == "what is the pix limit?"
    assert log_body["agent_response"] == "claude reply"


@respx.mock
def test_existing_string_system_gets_appended_to() -> None:
    register_backend()
    fake = FakeAnthropic(lambda _: make_message("ok"))
    wrapped = wrap_anthropic(fake, loop=make_loop())

    wrapped.messages.create(
        model="claude-opus-4-7",
        max_tokens=100,
        system="You are a Luma customer support bot.",
        messages=[{"role": "user", "content": "q"}],
    )

    sent = fake.calls[0]
    assert isinstance(sent["system"], str)
    assert sent["system"].startswith("You are a Luma customer support bot.")
    assert "Trusted facts from past corrections" in sent["system"]


@respx.mock
def test_agentloop_kwarg_stripped_before_forwarding() -> None:
    register_backend()
    fake = FakeAnthropic(lambda _: make_message("ok"))
    wrapped = wrap_anthropic(fake, loop=make_loop())

    wrapped.messages.create(
        model="claude-opus-4-7",
        max_tokens=100,
        messages=[{"role": "user", "content": "hi"}],
        agentloop={"user_id": "u_123", "signals": {"thumbs_down": True}},
    )

    sent = fake.calls[0]
    assert "agentloop" not in sent
    assert sent["model"] == "claude-opus-4-7"


@respx.mock
def test_skip_bypasses_both_hooks() -> None:
    register_backend()
    fake = FakeAnthropic(lambda _: make_message("ok"))
    wrapped = wrap_anthropic(fake, loop=make_loop())

    wrapped.messages.create(
        model="claude-opus-4-7",
        max_tokens=100,
        messages=[{"role": "user", "content": "health check"}],
        agentloop={"skip": True},
    )

    assert len(fake.calls) == 1
    assert len(respx.calls) == 0


def test_original_client_not_mutated() -> None:
    fake = FakeAnthropic(lambda _: make_message("ok"))
    original_messages = fake.messages
    wrapped = wrap_anthropic(fake, loop=AgentLoop(api_key="ak_test", base_url=BASE))

    assert fake.messages is original_messages
    assert wrapped.messages is not original_messages


def test_non_messages_namespaces_pass_through() -> None:
    fake = FakeAnthropic(lambda _: make_message("ok"))
    wrapped = wrap_anthropic(fake, loop=AgentLoop(api_key="ak_test", base_url=BASE))

    result = wrapped.models.list()
    assert result["data"][0]["id"] == "claude-opus-4-7"


@respx.mock
def test_ask_with_agentloop_standalone() -> None:
    register_backend()
    from agentloop_anthropic._ask import WrapOptions

    fake = FakeAnthropic(lambda _: make_message("direct"))
    resp = ask_with_agentloop(
        fake,
        messages=[{"role": "user", "content": "q"}],
        per_call=PerCallOptions(user_id="u_direct"),
        config=WrapOptions(loop=make_loop()),
        model="claude-opus-4-7",
        max_tokens=100,
    )

    assert resp.content[0].text == "direct"
    assert len(backend_calls_for("/v1/memories/search")) == 1
    assert len(backend_calls_for("/v1/turns")) == 1


@respx.mock
def test_signals_merge() -> None:
    register_backend()
    fake = FakeAnthropic(lambda _: make_message("I'm not sure — contact support."))

    def detect(_q: str, answer: str, _m: list[Any]) -> dict[str, Any] | None:
        if "not sure" in answer.lower() or "contact support" in answer.lower():
            return {"agent_punted": True}
        return None

    wrapped = wrap_anthropic(fake, loop=make_loop(), detect_signals=detect)
    wrapped.messages.create(
        model="claude-opus-4-7",
        max_tokens=100,
        messages=[{"role": "user", "content": "q"}],
        agentloop={"signals": {"sample": True}},
    )

    body = json.loads(backend_calls_for("/v1/turns")[0].content)
    assert body["signals"]["agent_punted"] is True
    assert body["signals"]["sample"] is True
