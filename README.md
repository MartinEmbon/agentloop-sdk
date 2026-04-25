# AgentLoop SDK

**Middleware that turns human corrections into searchable memory for your agent.**

When your agent gets something wrong, a human reviewer corrects it. Next time, the corrected fact is automatically retrieved and injected into the prompt — so the same mistake doesn't happen twice.

```
human correction → searchable memory → next prompt → no more mistake
```

This is a monorepo containing six SDK packages — three for JavaScript/TypeScript, three for Python — that integrate AgentLoop into your agent in two lines of code.

---

## Packages

### JavaScript / TypeScript

| Package | npm | Description |
|---|---|---|
| [`@agentloop-py/core`](./js/sdk) | `npm install @agentloop-py/core` | Core SDK — `search()`, `logTurn()`, `annotate()`, `feedbackUrl()` |
| [`@agentloop-py/openai`](./js/openai) | `npm install @agentloop-py/openai openai` | Drop-in OpenAI SDK wrapper |
| [`@agentloop-py/anthropic`](./js/anthropic) | `npm install @agentloop-py/anthropic @anthropic-ai/sdk` | Drop-in Anthropic SDK wrapper |

### Python

| Package | pip | Description |
|---|---|---|
| [`agentloop-py`](./py/sdk) | `pip install agentloop-py` | Core SDK, sync + async |
| [`agentloop-py-openai`](./py/openai) | `pip install agentloop-py-openai openai` | Drop-in OpenAI SDK wrapper |
| [`agentloop-py-anthropic`](./py/anthropic) | `pip install agentloop-py-anthropic anthropic` | Drop-in Anthropic SDK wrapper |

> **Note on the Python install name:** the install command is `pip install agentloop-py`, but the import is `from agentloop import AgentLoop` (the module name is `agentloop`, kept consistent with the JS SDK). This is a common pattern in Python — `pip install beautifulsoup4` then `from bs4 import ...`, etc.

---

## Quick start — JavaScript

```ts
import OpenAI from "openai";
import { AgentLoop } from "@agentloop-py/core";
import { wrapOpenAI } from "@agentloop-py/openai";

const openai = wrapOpenAI(
  new OpenAI(),
  { loop: new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! }) }
);

// Use exactly like the normal OpenAI SDK.
// AgentLoop hooks fire automatically — memory search before, log_turn after.
const resp = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "What's the Pix limit at night?" }],
});
```

## Quick start — Python

```python
import os
from openai import OpenAI
from agentloop import AgentLoop
from agentloop_openai import wrap_openai

openai = wrap_openai(
    OpenAI(),
    loop=AgentLoop(api_key=os.environ["AGENTLOOP_API_KEY"]),
)

resp = openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "What's the Pix limit at night?"}],
)
```

The `AGENTLOOP_API_KEY` is created in the AgentLoop dashboard. The wrapper handles memory retrieval, prompt augmentation, and turn logging automatically.

---

## Configuration

All SDKs respect the `AGENTLOOP_BASE_URL` environment variable for pointing at a different backend (local dev, staging, self-hosted, future gateway). Priority order:

1. Explicit `baseUrl` / `base_url` constructor option (highest)
2. `AGENTLOOP_BASE_URL` environment variable
3. Hosted Cloud Function (default fallback)

---

## Cross-language compatibility

The Python and JavaScript SDKs produce **byte-identical HMAC signatures** for the feedback URL. URLs signed in Python validate on a backend that also accepts JS-signed URLs, and vice versa.

Both languages hit the same backend, so deduplication, memory search, and the review queue work identically regardless of which SDK each call came from.

---

## Repository layout

```
agentloop-py/
├── js/
│   ├── sdk/        → @agentloop-py/core
│   ├── openai/     → @agentloop-py/openai
│   └── anthropic/  → @agentloop-py/anthropic
├── py/
│   ├── sdk/        → agentloop-py
│   ├── openai/     → agentloop-py-openai
│   └── anthropic/  → agentloop-py-anthropic
├── CHANGES.md      ← release notes + publishing instructions
├── LICENSE         ← MIT
└── README.md       ← you are here
```

Each package has its own README, examples, and tests.

---

## License

MIT — see [LICENSE](./LICENSE).
