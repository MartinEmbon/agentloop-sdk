"""
Example: wrap an OpenAI client with AgentLoop. Zero setup.

Compare with ../agentloop-sdk-py/examples/openai_manual.py to see the
difference — the wrapper handles retrieval, injection, and logging
automatically. All you do is pass `agentloop={...}` for per-call
overrides.

Run:
    pip install agentloop-sdk agentloop-openai openai
    export OPENAI_API_KEY=sk-...
    export AGENTLOOP_API_KEY=ak_...
    python examples/openai_wrapped.py "what's the pix limit at night?"
"""

from __future__ import annotations

import os
import sys

from openai import OpenAI

from agentloop import AgentLoop
from agentloop_openai import wrap_openai

AGENTLOOP_KEY = os.environ.get("AGENTLOOP_API_KEY")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
if not AGENTLOOP_KEY or not OPENAI_KEY:
    raise SystemExit(
        "Set AGENTLOOP_API_KEY and OPENAI_API_KEY env vars before running."
    )


def detect_signals(_q: str, answer: str, memories: list) -> dict | None:
    """Optional: flag turns for review based on the answer."""
    signals: dict[str, bool] = {}
    low = answer.lower()
    if "not sure" in low or "contact support" in low:
        signals["agent_punted"] = True
    if any(c in answer for c in "$R%"):
        signals["factual_claim"] = True
    if signals.get("factual_claim") and not memories:
        signals["low_confidence"] = True
    return signals or None


openai = wrap_openai(
    OpenAI(api_key=OPENAI_KEY),
    loop=AgentLoop(api_key=AGENTLOOP_KEY),
    detect_signals=detect_signals,
)


def ask(question: str, user_id: str = "demo_user") -> str:
    # Looks like a normal OpenAI call. AgentLoop hooks fire automatically.
    resp = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a helpful customer support assistant. Be concise."},
            {"role": "user", "content": question},
        ],
        temperature=0.2,
        agentloop={"user_id": user_id},
    )
    return resp.choices[0].message.content or ""


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "What's the Pix limit at night?"
    print(ask(q))
