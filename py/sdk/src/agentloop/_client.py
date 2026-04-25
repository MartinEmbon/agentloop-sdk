"""
AgentLoop synchronous client.

Use this if your code is sync (scripts, notebooks, Flask, Django sync
views, etc.). For asyncio code (FastAPI, aiohttp servers), use
AsyncAgentLoop from agentloop.aio instead.
"""

from __future__ import annotations

from typing import Any

import httpx

from ._common import (
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_S,
    auth_headers,
    build_annotate_payload,
    build_feedback_url,
    build_log_turn_payload,
    build_search_payload,
    normalize_base_url,
    parse_error_message,
)
from .types import (
    AgentLoopError,
    AnnotateResponse,
    LogTurnResponse,
    Memory,
    Rating,
    RootCause,
)


class AgentLoop:
    """Synchronous AgentLoop client.

    Usage:

        from agentloop import AgentLoop

        loop = AgentLoop(api_key="ak_...")

        # Before your LLM call
        memories = loop.search("what's the pix limit?")

        # After your LLM call
        loop.log_turn(question, answer, user_id="u_123")

    Methods `search()` and `log_turn()` degrade gracefully on failure
    (return empty/default value) unless `throw_on_error=True`. `annotate()`
    always raises on failure — reviewer work should never be silently
    dropped.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        feedback_signing_secret: str = "",
        throw_on_error: bool = False,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise AgentLoopError("api_key is required")

        self.api_key = api_key
        self.base_url = normalize_base_url(base_url)
        self.timeout_s = timeout_s
        self.feedback_signing_secret = feedback_signing_secret
        self.throw_on_error = throw_on_error

        # Callers can inject their own httpx.Client for custom transports,
        # mocking, or connection pooling tuning. If not provided, we own one.
        self._http = http_client or httpx.Client(timeout=timeout_s)
        self._owned_http = http_client is None

    # ------------------------------------------------------------------
    # Context manager — lets callers `with AgentLoop(...) as loop:` to
    # guarantee the underlying httpx client is closed.
    # ------------------------------------------------------------------

    def __enter__(self) -> AgentLoop:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owned_http:
            self._http.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        user_id: str | None = None,
        limit: int = 3,
        tags: list[str] | None = None,
    ) -> list[Memory]:
        """Retrieve relevant corrections. Call before your LLM call."""
        body = build_search_payload(query, user_id=user_id, limit=limit, tags=tags)
        try:
            data = self._request("POST", "/v1/memories/search", body)
            return [Memory.from_api(m) for m in data.get("memories", [])]
        except AgentLoopError:
            if self.throw_on_error:
                raise
            return []

    def log_turn(
        self,
        question: str,
        agent_response: str,
        *,
        user_id: str | None = None,
        session_id: str | None = None,
        signals: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> LogTurnResponse:
        """Queue a turn for review. Call after your LLM responds."""
        body = build_log_turn_payload(
            question,
            agent_response,
            user_id=user_id,
            session_id=session_id,
            signals=signals,
            metadata=metadata,
        )
        try:
            data = self._request("POST", "/v1/turns", body)
            return LogTurnResponse.from_api(data)
        except AgentLoopError:
            if self.throw_on_error:
                raise
            return LogTurnResponse(turn_id="", status="error", was_duplicate=False)

    def annotate(
        self,
        *,
        question: str,
        agent_response: str,
        correction: str,
        rating: Rating,
        root_cause: RootCause | None = None,
        tags: list[str] | None = None,
        reviewer: str | None = None,
        user_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AnnotateResponse:
        """Create an annotation directly (bypass the review queue).

        Unlike search() and log_turn(), always raises on failure. Silent
        degradation would hide reviewer work.
        """
        if not question or not agent_response or not correction:
            raise AgentLoopError(
                "question, agent_response, and correction are required"
            )
        body = build_annotate_payload(
            question=question,
            agent_response=agent_response,
            correction=correction,
            rating=rating,
            root_cause=root_cause,
            tags=tags,
            reviewer=reviewer,
            user_id=user_id,
            metadata=metadata,
        )
        data = self._request("POST", "/v1/annotations", body)
        return AnnotateResponse.from_api(data)

    def feedback_url(
        self,
        question: str,
        agent_response: str,
        *,
        user_id: str = "",
        session_id: str = "",
    ) -> str:
        """HMAC-signed URL for the feedback widget. Sync; no network call."""
        if not self.feedback_signing_secret:
            raise AgentLoopError(
                "feedback_signing_secret is required for feedback_url()"
            )
        return build_feedback_url(
            self.base_url,
            self.feedback_signing_secret,
            question=question,
            agent_response=agent_response,
            user_id=user_id,
            session_id=session_id,
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            resp = self._http.request(
                method,
                url,
                headers=auth_headers(self.api_key),
                json=payload,
                timeout=self.timeout_s,
            )
        except httpx.TimeoutException as e:
            raise AgentLoopError(
                f"Request to {path} timed out after {self.timeout_s}s", 0, ""
            ) from e
        except httpx.HTTPError as e:
            raise AgentLoopError(f"Network error on {path}: {e}", 0, "") from e

        body_text = resp.text
        if resp.status_code >= 400:
            raise AgentLoopError(
                parse_error_message(resp.status_code, body_text),
                resp.status_code,
                body_text,
            )

        if not body_text:
            return {}
        try:
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except ValueError as e:
            raise AgentLoopError(
                f"Invalid JSON from {path}", resp.status_code, body_text
            ) from e
