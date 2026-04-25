"""
Example: wrap an Anthropic client with AgentLoop. Zero setup.

Run:
    pip install agentloop-sdk agentloop-anthropic anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    export AGENTLOOP_API_KEY=ak_...
    python examples/anthropic_wrapped.py "what's the pix limit at night?"
"""

from __future__ import annotations

import os
import sys

from anthropic import Anthropic

from agentloop import AgentLoop
from agentloop_anthropic import wrap_anthropic

AGENTLOOP_KEY = os.environ.get("AGENTLOOP_API_KEY")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not AGENTLOOP_KEY or not ANTHROPIC_KEY:
    raise SystemExit(
        "Set AGENTLOOP_API_KEY and ANTHROPIC_API_KEY env vars before running."
    )


def detect_signals(_q: str, answer: str, memories: list) -> dict | None:
    signals: dict[str, bool] = {}
    low = answer.lower()
    if "not sure" in low or "contact support" in low:
        signals["agent_punted"] = True
    if any(c in answer for c in "$R%"):
        signals["factual_claim"] = True
    if signals.get("factual_claim") and not memories:
        signals["low_confidence"] = True
    return signals or None


anthropic = wrap_anthropic(
    Anthropic(api_key=ANTHROPIC_KEY),
    loop=AgentLoop(api_key=AGENTLOOP_KEY),
    detect_signals=detect_signals,
)


def ask(question: str, user_id: str = "demo_user") -> str:
    msg = anthropic.messages.create(
        model="claude-opus-4-7",
        max_tokens=1024,
        system="You are a helpful customer support assistant. Be concise.",
        messages=[{"role": "user", "content": question}],
        agentloop={"user_id": user_id},
    )
    # Anthropic's content is a list of blocks — extract text
    return "".join(
        block.text for block in msg.content if getattr(block, "type", None) == "text"
    )


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "What's the Pix limit at night?"
    print(ask(q))
