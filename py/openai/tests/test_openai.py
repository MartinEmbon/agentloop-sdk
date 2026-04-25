"""
Tests for agentloop-openai.

Uses a fake OpenAI client + respx for the AgentLoop backend. No real
network, no real OpenAI.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
import respx

from agentloop import AgentLoop
from agentloop_openai import PerCallOptions, ask_with_agentloop, wrap_openai

BASE = "https://api.example.com"


# ---------------------------------------------------------------------------
# Fake OpenAI
# ---------------------------------------------------------------------------


@dataclass
class FakeMessage:
    content: str
    role: str = "assistant"


@dataclass
class FakeChoice:
    message: FakeMessage
    index: int = 0
    finish_reason: str = "stop"


@dataclass
class FakeCompletion:
    choices: list[FakeChoice]
    id: str = "chatcmpl_fake"
    model: str = "gpt-4o-mini"


class FakeCompletions:
    def __init__(self, handler: Any) -> None:
        self._handler = handler
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self._handler(kwargs)


class FakeChat:
    def __init__(self, completions: FakeCompletions) -> None:
        self.completions = completions


class FakeEmbeddings:
    def create(self, **kwargs: Any) -> Any:
        return {"data": [{"embedding": [0.1, 0.2]}]}


class FakeOpenAI:
    def __init__(self, handler: Any) -> None:
        self._completions = FakeCompletions(handler)
        self.chat = FakeChat(self._completions)
        self.embeddings = FakeEmbeddings()

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self._completions.calls


def make_completion(text: str) -> FakeCompletion:
    return FakeCompletion(choices=[FakeChoice(message=FakeMessage(content=text))])


# ---------------------------------------------------------------------------
# Backend helpers
# ---------------------------------------------------------------------------


def register_backend() -> None:
    """Register search + log_turn routes on the active respx router."""
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


def test_wrap_openai_requires_loop() -> None:
    fake = FakeOpenAI(lambda _: make_completion("x"))
    with pytest.raises((ValueError, TypeError)):
        wrap_openai(fake, loop=None)  # type: ignore[arg-type]


@respx.mock
def test_basic_pre_post_hooks_fire() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("gpt reply"))
    wrapped = wrap_openai(fake, loop=make_loop())

    resp = wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "what is the pix limit?"}],
    )

    assert resp.choices[0].message.content == "gpt reply"

    search = backend_calls_for("/v1/memories/search")
    assert len(search) == 1
    body = json.loads(search[0].content)
    assert body["query"] == "what is the pix limit?"

    # Memory injected
    sent = fake.calls[0]
    system = next((m for m in sent["messages"] if m["role"] == "system"), None)
    assert system is not None
    assert "Fact relevant to: what is the pix limit?" in system["content"]

    # log_turn fired
    logs = backend_calls_for("/v1/turns")
    assert len(logs) == 1
    log_body = json.loads(logs[0].content)
    assert log_body["question"] == "what is the pix limit?"
    assert log_body["agent_response"] == "gpt reply"


@respx.mock
def test_agentloop_kwarg_stripped_before_forwarding() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("ok"))
    wrapped = wrap_openai(fake, loop=make_loop())

    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        agentloop={"user_id": "u_123", "signals": {"thumbs_down": True}},
    )

    sent = fake.calls[0]
    assert "agentloop" not in sent
    assert sent["model"] == "gpt-4o-mini"


@respx.mock
def test_per_call_user_id_forwarded() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("ok"))
    wrapped = wrap_openai(fake, loop=make_loop())

    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "q"}],
        agentloop={"user_id": "u_abc"},
    )

    search_body = json.loads(backend_calls_for("/v1/memories/search")[0].content)
    log_body = json.loads(backend_calls_for("/v1/turns")[0].content)
    assert search_body["user_id"] == "u_abc"
    assert log_body["user_id"] == "u_abc"


@respx.mock
def test_skip_bypasses_both_hooks() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("ok"))
    wrapped = wrap_openai(fake, loop=make_loop())

    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "health check"}],
        agentloop={"skip": True},
    )

    assert len(fake.calls) == 1
    assert len(respx.calls) == 0


@respx.mock
def test_search_false_skips_retrieval_but_logs() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("ok"))
    wrapped = wrap_openai(fake, loop=make_loop())

    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "q"}],
        agentloop={"search": False},
    )

    assert len(backend_calls_for("/v1/memories/search")) == 0
    assert len(backend_calls_for("/v1/turns")) == 1


@respx.mock
def test_signals_merge_from_detect_and_per_call() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("I'm not sure, contact support."))

    def detect(_q: str, answer: str, _m: list[Any]) -> dict[str, Any] | None:
        if "not sure" in answer.lower() or "contact support" in answer.lower():
            return {"agent_punted": True}
        return None

    wrapped = wrap_openai(fake, loop=make_loop(), detect_signals=detect)
    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "q"}],
        agentloop={"signals": {"sample": True}},
    )

    body = json.loads(backend_calls_for("/v1/turns")[0].content)
    assert body["signals"]["agent_punted"] is True
    assert body["signals"]["sample"] is True


def test_original_client_not_mutated() -> None:
    fake = FakeOpenAI(lambda _: make_completion("ok"))
    # Capture the underlying object, not a bound method (which is
    # recreated each attribute access and wouldn't be identity-equal
    # even without any mutation).
    original_completions = fake.chat.completions
    wrapped = wrap_openai(fake, loop=AgentLoop(api_key="ak_test", base_url=BASE))

    # Underlying client's completions object unchanged.
    assert fake.chat.completions is original_completions
    # Wrapped client exposes a DIFFERENT completions object — the proxy.
    assert wrapped.chat.completions is not original_completions


def test_non_chat_namespaces_pass_through() -> None:
    fake = FakeOpenAI(lambda _: make_completion("ok"))
    wrapped = wrap_openai(fake, loop=AgentLoop(api_key="ak_test", base_url=BASE))

    result = wrapped.embeddings.create(input="hi", model="text-embedding-3-small")
    assert result["data"][0]["embedding"] == [0.1, 0.2]


@respx.mock
def test_ask_with_agentloop_standalone() -> None:
    register_backend()
    from agentloop_openai._ask import WrapOptions

    fake = FakeOpenAI(lambda _: make_completion("direct"))
    resp = ask_with_agentloop(
        fake,
        messages=[{"role": "user", "content": "q"}],
        per_call=PerCallOptions(user_id="u_direct"),
        config=WrapOptions(loop=make_loop()),
        model="gpt-4o-mini",
    )

    assert resp.choices[0].message.content == "direct"
    assert len(backend_calls_for("/v1/memories/search")) == 1
    assert len(backend_calls_for("/v1/turns")) == 1


@respx.mock
def test_custom_inject_memories() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("ok"))

    def custom(memories: list[Any], messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {"role": "user", "content": f"CONTEXT: {' | '.join(m.fact for m in memories)}"},
            *messages,
        ]

    wrapped = wrap_openai(fake, loop=make_loop(), inject_memories=custom)
    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "q"}],
    )

    sent = fake.calls[0]
    assert sent["messages"][0]["role"] == "user"
    assert sent["messages"][0]["content"].startswith("CONTEXT:")


@respx.mock
def test_only_log_when_signaled_skips_when_no_signals() -> None:
    register_backend()
    fake = FakeOpenAI(lambda _: make_completion("neutral"))
    wrapped = wrap_openai(fake, loop=make_loop(), only_log_when_signaled=True)

    wrapped.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "q"}],
    )

    assert len(backend_calls_for("/v1/turns")) == 0
