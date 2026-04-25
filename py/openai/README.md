# agentloop-py-openai

Drop-in wrapper that adds [AgentLoop](https://agentloop.dev) memory
retrieval and turn logging to every `openai.chat.completions.create`
call.

```python
from openai import OpenAI
from agentloop import AgentLoop
from agentloop_openai import wrap_openai

openai = wrap_openai(
    OpenAI(),
    loop=AgentLoop(api_key="ak_..."),
)

# Use exactly like the normal OpenAI SDK.
# Memory search fires before; log_turn fires after.
resp = openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "What's the Pix limit at night?"}],
)
```

That's the whole integration.

## What happens under the hood

For every `chat.completions.create` call:

1. Extracts the last user message as the query
2. Calls `loop.search(query)` — pulls any relevant corrections
3. Injects them into your system prompt (or creates one if absent)
4. Calls OpenAI with the augmented messages
5. Calls `loop.log_turn(question, answer)` with the result

If either AgentLoop call fails, your OpenAI call still succeeds.

## Install

```bash
pip install agentloop-py agentloop-py-openai openai
```

## Per-call options

Pass an `agentloop` kwarg alongside your normal OpenAI params. The
wrapper strips it before forwarding (OpenAI rejects unknown kwargs).

```python
resp = openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[...],
    agentloop={
        "user_id": "u_123",                        # scope memory search + log_turn
        "session_id": "sess_abc",                  # passed to log_turn
        "signals": {"thumbs_down": True},          # merged with auto-detected
        "metadata": {"latency_budget_ms": 500},    # stored with the turn
        "skip": False,                             # True = bypass AgentLoop entirely
        "search": False,                           # skip only retrieval (still logs)
        # or "search": {"limit": 5, "tags": ["pix"]}
    },
)
```

You can also pass a typed `PerCallOptions` instance if you prefer:

```python
from agentloop_openai import PerCallOptions

resp = openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[...],
    agentloop=PerCallOptions(user_id="u_123", signals={"thumbs_down": True}),
)
```

## Configuration (passed at wrap time)

```python
openai = wrap_openai(
    OpenAI(),
    loop=loop,

    # Custom memory injection. Default: append to system prompt.
    inject_memories=lambda memories, messages: [...],

    # Auto-detect signals from the response before log_turn.
    detect_signals=lambda question, answer, memories: {
        "agent_punted": "not sure" in answer.lower(),
        "factual_claim": "$" in answer or "%" in answer,
    },

    # Max memories per call. Default 3.
    search_limit=3,

    # Apply these tags to every memory search.
    search_tags=["production"],

    # Only log turns when at least one signal fired. Default False.
    only_log_when_signaled=False,
)
```

## Low-level API

For callers who want explicit control:

```python
from agentloop_openai import ask_with_agentloop, PerCallOptions
from agentloop_openai._ask import WrapOptions

resp = ask_with_agentloop(
    openai,                           # raw, unwrapped OpenAI client
    messages=[{"role": "user", "content": question}],
    per_call=PerCallOptions(user_id="u_123"),
    config=WrapOptions(loop=loop),
    model="gpt-4o-mini",              # forwarded to OpenAI
    temperature=0.2,                  # forwarded to OpenAI
)
```

## Not mutated

`wrap_openai(client)` returns a distinct wrapper. Your original client
stays unwrapped and usable.

```python
raw = OpenAI()
wrapped = wrap_openai(raw, loop=loop)

raw.chat.completions.create(...)       # no AgentLoop hooks
wrapped.chat.completions.create(...)   # with AgentLoop hooks
```

## Streaming

**Not supported in v0.1.** Streaming intercepts are planned for a later
release (requires buffering assistant text to call `log_turn` after the
stream closes). For now, if you pass `stream=True`, call `AgentLoop`
methods directly rather than using the wrapper.

## License

MIT
