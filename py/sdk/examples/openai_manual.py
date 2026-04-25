"""
Example: manual AgentLoop integration with OpenAI.

This is the low-level pattern — call loop.search() before, loop.log_turn()
after. For a zero-setup drop-in, use agentloop-openai instead.

Run:
    pip install agentloop-sdk openai
    export OPENAI_API_KEY=sk-...
    export AGENTLOOP_API_KEY=ak_...
    python examples/openai_manual.py "what's the pix limit at night?"
"""

from __future__ import annotations

import os
import random
import sys

from openai import OpenAI

from agentloop import AgentLoop

AGENTLOOP_KEY = os.environ.get("AGENTLOOP_API_KEY")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
if not AGENTLOOP_KEY or not OPENAI_KEY:
    raise SystemExit(
        "Set AGENTLOOP_API_KEY and OPENAI_API_KEY env vars before running."
    )

loop = AgentLoop(api_key=AGENTLOOP_KEY)
openai = OpenAI(api_key=OPENAI_KEY)

# Percentage of turns logged even if no signal fires. Gives reviewers
# baseline visibility. 15% is a reasonable default.
SAMPLE_RATE = 0.15

PUNT_PHRASES = (
    "i'm not sure", "i am not sure", "i don't know", "i do not know",
    "contact support", "unable to answer",
)


def detect_agent_punted(response: str) -> bool:
    low = response.lower()
    return any(p in low for p in PUNT_PHRASES)


def detect_factual_claim(response: str) -> bool:
    import re
    if re.search(r"\$|R\$|%", response):
        return True
    return bool(re.search(r"\d", response)) and bool(
        re.search(r"\b(day|hour|week|month|year)\b", response, re.IGNORECASE)
    )


def ask(question: str, user_id: str = "demo_user") -> str:
    # 1. Retrieve corrections
    memories = loop.search(question, user_id=user_id, limit=3)

    # 2. Inject into system prompt
    system = "You are a helpful customer support assistant. Be concise."
    if memories:
        system += "\n\nTrusted facts from past corrections:\n"
        system += "\n".join(f"- {m.fact}" for m in memories)

    # 3. Call the LLM
    resp = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": question},
        ],
        temperature=0.2,
    )
    answer = resp.choices[0].message.content or ""

    # 4. Signal detection
    signals: dict[str, object] = {}
    if detect_agent_punted(answer):
        signals["agent_punted"] = True
    if detect_factual_claim(answer):
        signals["factual_claim"] = True
    # Low confidence: factual claim without any memory backing it.
    if signals.get("factual_claim") and not memories:
        signals["low_confidence"] = True

    # Random sampling for baseline coverage
    if not signals and random.random() < SAMPLE_RATE:
        signals["sample"] = True

    # 5. Log the turn if anything fired
    if signals:
        result = loop.log_turn(
            question=question,
            agent_response=answer,
            user_id=user_id,
            signals=signals,
            metadata={"memories_injected": len(memories)},
        )
        tag = " (duplicate)" if result.was_duplicate else ""
        print(f"[agentloop] logged turn {result.turn_id}{tag}", file=sys.stderr)

    return answer


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "What's the Pix limit at night?"
    print(ask(q))
