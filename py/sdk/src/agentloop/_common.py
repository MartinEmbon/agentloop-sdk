"""
Shared plumbing for both sync and async clients.

Kept as module-level functions (no class) because none of this is
stateful — it's just pure payload-shaping and HMAC. Both AgentLoop and
AsyncAgentLoop delegate here.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any
from urllib.parse import urlencode


import os

# Fallback URL used when neither the `base_url` constructor argument nor
# the AGENTLOOP_BASE_URL env var is set. Kept here as a constant so
# future backend URL changes (e.g. once we move behind a gateway) land
# in one place.
FALLBACK_BASE_URL = "https://us-central1-easymenu-457215.cloudfunctions.net/agentloop-api"

# Public alias kept for backward compatibility — some callers may have
# imported DEFAULT_BASE_URL directly. Behaves identically to the
# resolution order now that env-var support exists.
DEFAULT_BASE_URL = FALLBACK_BASE_URL
DEFAULT_TIMEOUT_S = 10.0


def normalize_base_url(url: str | None) -> str:
    """Resolve and normalize the base URL to use for API calls.

    Priority, highest first:
      1. Explicit `url` argument — caller said exactly this, respect it.
      2. ``AGENTLOOP_BASE_URL`` env var — ops/deployment override
         without a code change (useful for local dev, staging, self-
         hosted deployments, or pointing at a future gateway).
      3. Hardcoded fallback — the current Cloud Function.
    """
    resolved = url or os.environ.get("AGENTLOOP_BASE_URL") or FALLBACK_BASE_URL
    return resolved.rstrip("/")


def auth_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Payload builders — keep request shaping close to the backend contract
# so a field change only needs to land in one place.
# ---------------------------------------------------------------------------


def build_search_payload(
    query: str,
    *,
    user_id: str | None = None,
    limit: int = 3,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"query": query, "limit": limit}
    if user_id:
        body["user_id"] = user_id
    if tags:
        body["tags"] = tags
    return body


def build_log_turn_payload(
    question: str,
    agent_response: str,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    signals: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "question": question,
        "agent_response": agent_response,
    }
    if user_id:
        body["user_id"] = user_id
    if session_id:
        body["session_id"] = session_id
    if signals:
        body["signals"] = signals
    if metadata:
        body["metadata"] = metadata
    return body


def build_annotate_payload(
    *,
    question: str,
    agent_response: str,
    correction: str,
    rating: str,
    root_cause: str | None = None,
    tags: list[str] | None = None,
    reviewer: str | None = None,
    user_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "question": question,
        "agent_response": agent_response,
        "correction": correction,
        "rating": rating,
    }
    if root_cause:
        body["root_cause"] = root_cause
    if tags:
        body["tags"] = tags
    if reviewer:
        body["reviewer"] = reviewer
    if user_id:
        body["user_id"] = user_id
    if metadata:
        body["metadata"] = metadata
    return body


# ---------------------------------------------------------------------------
# Feedback URL HMAC
# ---------------------------------------------------------------------------


def build_feedback_url(
    base_url: str,
    secret: str,
    *,
    question: str,
    agent_response: str,
    user_id: str = "",
    session_id: str = "",
) -> str:
    """Build an HMAC-SHA256 signed URL for the feedback widget.

    Signature format matches the JS SDK and the Luma reference — sorted
    JSON keys, HMAC-SHA256 hex digest. Byte-identical across all three
    implementations.
    """
    ts = int(time.time())
    payload = {
        "q": question,
        "a": agent_response,
        "u": user_id,
        "s": session_id,
        "t": ts,
    }
    canonical = json.dumps(payload, sort_keys=True)
    sig = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    query = urlencode({**payload, "sig": sig})
    return f"{base_url}/feedback?{query}"


# ---------------------------------------------------------------------------
# Response parsing — shared between sync and async so error translation
# is consistent.
# ---------------------------------------------------------------------------


def parse_error_message(status_code: int, body_text: str) -> str:
    """Extract a human-readable error from the backend's response body."""
    if not body_text:
        return f"Request failed: {status_code}"
    try:
        parsed = json.loads(body_text)
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
            return parsed["error"]
    except (json.JSONDecodeError, ValueError):
        pass
    return f"Request failed: {status_code}"
