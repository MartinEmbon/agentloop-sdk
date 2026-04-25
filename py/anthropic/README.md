# agentloop-py-anthropic

Drop-in wrapper that adds [AgentLoop](https://agentloop.dev) memory
retrieval and turn logging to every `anthropic.messages.create` call.

```python
from anthropic import Anthropic
from agentloop import AgentLoop
from agentloop_anthropic import wrap_anthropic

anthropic = wrap_anthropic(
    Anthropic(),
    loop=AgentLoop(api_key="ak_..."),
)

msg = anthropic.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "What's the Pix limit at night?"}],
)
```

That's the whole integration.

## What happens under the hood

For every `messages.create` call:

1. Extracts the last user message as the query
2. Calls `loop.search(query)` — pulls any relevant corrections
3. Appends them to your `system` prompt (or creates one if absent)
4. Calls Anthropic with the augmented system prompt
5. Calls `loop.log_turn(question, answer)` with the assembled text

If either AgentLoop call fails, your Anthropic call still succeeds.

## Install

```bash
pip install agentloop-py agentloop-py-anthropic anthropic
```

## Per-call options

```python
msg = anthropic.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[...],
    agentloop={
        "user_id": "u_123",
        "session_id": "sess_abc",
        "signals": {"thumbs_down": True},
        "metadata": {"latency_budget_ms": 500},
        "skip": False,
        "search": False,  # or {"limit": 5, "tags": ["pix"]}
    },
)
```

## Configuration (passed at wrap time)

```python
anthropic = wrap_anthropic(
    Anthropic(),
    loop=loop,

    # Custom memory injection. Default: append to system prompt.
    # Handles both string and array-of-text-blocks system forms.
    inject_memories=lambda memories, existing_system: ...,

    # Auto-detect signals from the response before log_turn.
    detect_signals=lambda question, answer, memories: {
        "agent_punted": "not sure" in answer.lower(),
    },

    search_limit=3,
    search_tags=["production"],
    only_log_when_signaled=False,
)
```

## Low-level API

```python
from agentloop_anthropic import ask_with_agentloop, PerCallOptions
from agentloop_anthropic._ask import WrapOptions

resp = ask_with_agentloop(
    anthropic,                        # raw, unwrapped Anthropic client
    messages=[{"role": "user", "content": question}],
    per_call=PerCallOptions(user_id="u_123"),
    config=WrapOptions(loop=loop),
    model="claude-opus-4-7",
    max_tokens=1024,
)
```

## Not mutated

`wrap_anthropic(client)` returns a distinct wrapper. Your original
client stays unwrapped and usable.

## Streaming

**Not supported in v0.1.** Same note as `agentloop-py-openai` — planned
for a later release.

## License

MIT
