"""
Public types and exceptions for the AgentLoop Python SDK.

Everything here is importable from the top-level package:

    from agentloop import Memory, LogTurnResponse, AgentLoopError
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


# ---------------------------------------------------------------------------
# Response shapes (returned from SDK methods)
# ---------------------------------------------------------------------------


@dataclass
class Memory:
    """A correction returned by search()."""

    id: str
    fact: str
    score: float
    tags: list[str] = field(default_factory=list)
    source: str = ""
    created_at: str = ""

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> Memory:
        return cls(
            id=data.get("id", ""),
            fact=data.get("fact", ""),
            score=float(data.get("score", 0.0)),
            tags=list(data.get("tags") or []),
            source=data.get("source", ""),
            created_at=data.get("created_at", ""),
        )


@dataclass
class LogTurnResponse:
    """Response from log_turn().

    Round 9: `was_duplicate` is True when the backend deduplicated this
    turn against an existing pending turn with the same normalized
    question. The returned `turn_id` points to the merged document
    either way.
    """

    turn_id: str
    status: str  # "pending"
    was_duplicate: bool = False

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> LogTurnResponse:
        return cls(
            turn_id=data.get("turn_id", ""),
            status=data.get("status", "pending"),
            was_duplicate=bool(data.get("was_duplicate", False)),
        )


@dataclass
class AnnotateResponse:
    """Response from annotate()."""

    annotation_id: str
    memory_id: str
    status: str  # "active" | "updated_existing"
    duplicate_score: float | None = None

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> AnnotateResponse:
        return cls(
            annotation_id=data.get("annotation_id", ""),
            memory_id=data.get("memory_id", ""),
            status=data.get("status", "active"),
            duplicate_score=data.get("duplicate_score"),
        )


# ---------------------------------------------------------------------------
# Public literal types — helpful autocomplete for callers
# ---------------------------------------------------------------------------

Rating = Literal["incorrect", "partial", "correct"]
RootCause = Literal["context", "prompt", "model", "tool"]


# ---------------------------------------------------------------------------
# Error
# ---------------------------------------------------------------------------


class AgentLoopError(Exception):
    """Raised when `throw_on_error=True` and an AgentLoop call fails.

    `status` is the HTTP status code (0 for network/timeout errors).
    `body` is the raw response body for debugging.
    """

    def __init__(self, message: str, status: int = 0, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.body = body
