# agentloop

Python SDK for [AgentLoop](https://agentloop.dev) — middleware that
turns human corrections into searchable memory for your agent.

- **Python 3.9+**, sync and async
- **One runtime dependency** (`httpx`), nothing else
- **Graceful by default** — network blips don't break your agent
- **Type hints throughout**, full dataclass response shapes

## Install

```bash
pip install agentloop-py
```

## Quick start (sync)

```python
import os
from openai import OpenAI
from agentloop import AgentLoop

loop = AgentLoop(api_key=os.environ["AGENTLOOP_API_KEY"])
openai = OpenAI()

def ask(question: str, user_id: str) -> str:
    # 1. Before calling the LLM, pull relevant corrections.
    memories = loop.search(question, user_id=user_id, limit=3)

    # 2. Inject them into your system prompt.
    facts = "\n".join(f"- {m.fact}" for m in memories) if memories else ""
    system = "You are a helpful assistant."
    if facts:
        system += f"\n\nTrusted facts from past corrections:\n{facts}"

    # 3. Call the LLM.
    resp = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": question},
        ],
    )
    answer = resp.choices[0].message.content or ""

    # 4. Log the turn for review.
    loop.log_turn(question, answer, user_id=user_id)

    return answer
```

That's the whole integration — one call before the LLM, one after. For
a zero-setup drop-in wrapper, install `agentloop-py-openai` or
`agentloop-py-anthropic` instead.

## Quick start (async)

```python
from agentloop.aio import AsyncAgentLoop

async def ask(question: str, user_id: str) -> str:
    async with AsyncAgentLoop(api_key=...) as loop:
        memories = await loop.search(question, user_id=user_id)
        # ... LLM call ...
        await loop.log_turn(question, answer, user_id=user_id)
```

Use `AsyncAgentLoop` from `agentloop.aio` in asyncio code (FastAPI,
aiohttp, etc.). Same API, all methods are coroutines except
`feedback_url()` which stays sync — no network call, just HMAC.

## Configuration

```python
loop = AgentLoop(
    api_key="ak_...",                           # required
    base_url="https://...",                     # default: hosted Cloud Function
    timeout_s=10.0,                             # per-request timeout
    feedback_signing_secret="...",              # only needed for feedback_url()
    throw_on_error=False,                       # see "Graceful failures"
    http_client=my_httpx_client,                # inject custom httpx.Client
)
```

### Base URL resolution

The `base_url` argument follows this priority order:

1. Explicit `base_url` passed to the constructor (highest)
2. `AGENTLOOP_BASE_URL` environment variable
3. Hardcoded Cloud Function URL (fallback)

This lets you point the SDK at a local dev server, a self-hosted
deployment, or a future gateway without code changes — just set
`AGENTLOOP_BASE_URL` in the environment.

```bash
export AGENTLOOP_BASE_URL=https://api.agentloop.dev
python your_app.py  # now uses the gateway URL automatically
```

## Four methods

### `search(query, *, user_id=None, limit=3, tags=None) → list[Memory]`

Retrieve corrections before your LLM call. Returns `[]` on failure
(unless `throw_on_error=True`).

```python
memories = loop.search("pix limit at night", user_id="u_123", limit=5)
for m in memories:
    print(m.fact, m.score, m.tags)
```

### `log_turn(question, agent_response, *, user_id=None, session_id=None, signals=None, metadata=None) → LogTurnResponse`

Queue a turn for review. Returns a default response on failure (unless
`throw_on_error=True`).

```python
result = loop.log_turn(
    question="What's the Pix limit?",
    agent_response="R$5,000",
    user_id="u_123",
    signals={"thumbs_down": True},
    metadata={"latency_ms": 240, "model": "gpt-4o-mini"},
)
if result.was_duplicate:
    # Backend deduplicated this turn against an existing pending one.
    # The returned turn_id points to the merged doc.
    ...
```

### `annotate(*, question, agent_response, correction, rating, ...) → AnnotateResponse`

Create an annotation directly (bypass the review queue). **Always
throws on failure** — silent degradation would hide reviewer work.

```python
result = loop.annotate(
    question="What's the Pix limit at night?",
    agent_response="R$5,000",
    correction="Pix limit between 8pm and 6am is R$1,000.",
    rating="incorrect",
    root_cause="context",
    tags=["pix", "limits"],
    reviewer="maria@luma.com.br",
)
```

### `feedback_url(question, agent_response, *, user_id="", session_id="") → str`

Generate an HMAC-signed URL for the embedded feedback widget. Requires
`feedback_signing_secret`. Sync on both clients.

```python
url = loop.feedback_url(question, answer, user_id="u_123")
```

Signatures are byte-identical to the JavaScript SDK, so URLs signed in
Python validate on backends that also accept JS-signed URLs.

## Graceful failures

By default, `search()` and `log_turn()` return empty/default values on
failure. Agent-loop calls sit on the critical path of your agent's
response; a blip shouldn't turn into a 500.

```python
# Hard failures
from agentloop import AgentLoopError

loop = AgentLoop(api_key=..., throw_on_error=True)
try:
    memories = loop.search("...")
except AgentLoopError as e:
    print(e.status, e.body)
```

`annotate()` always raises regardless of this flag.

## Context managers

Both clients support context management for clean resource cleanup:

```python
with AgentLoop(api_key=...) as loop:
    loop.search("...")
# httpx.Client is closed on exit

async with AsyncAgentLoop(api_key=...) as loop:
    await loop.search("...")
# httpx.AsyncClient is closed on exit
```

## License

MIT
