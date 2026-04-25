# @agentloop-sdk/core

JavaScript / TypeScript SDK for [AgentLoop](https://agentloop.dev) — the
middleware that turns human corrections into searchable memory for your
agent.

- **Runtime**: Node 18+, Cloudflare Workers, Vercel Edge, browsers
- **Zero runtime dependencies** — uses native `fetch` and Web Crypto
- **TypeScript-first**, ships `.d.ts` and `.d.cts` for both ESM and CJS
- **Graceful by default** — network blips don't break your agent

## Install

```bash
npm install @agentloop-sdk/core
```

## Quick start

```ts
import { AgentLoop } from "@agentloop-sdk/core";
import OpenAI from "openai";

const loop = new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! });
const openai = new OpenAI();

async function ask(question: string, userId: string) {
  // 1. Before calling the LLM, pull any relevant corrections.
  const memories = await loop.search(question, { user_id: userId, limit: 3 });

  // 2. Inject them into your system prompt.
  const factsBlock = memories.length
    ? "\n\nRelevant facts from past corrections:\n" +
      memories.map((m) => `- ${m.fact}`).join("\n")
    : "";

  // 3. Call the LLM.
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a helpful assistant." + factsBlock },
      { role: "user", content: question },
    ],
  });
  const answer = resp.choices[0].message.content ?? "";

  // 4. Log the turn for review. Fire any signals you detected.
  await loop.logTurn(question, answer, {
    user_id: userId,
    signals: detectSignals(answer),
  });

  return answer;
}

function detectSignals(answer: string) {
  const signals: Record<string, boolean> = {};
  if (/i['’]?m not sure|i don['’]?t know/i.test(answer)) {
    signals.agent_punted = true;
  }
  return signals;
}
```

That's the whole integration. One call before the LLM, one call after.

## Configuration

```ts
new AgentLoop({
  apiKey: "ak_...",                  // required
  baseUrl: "https://...",            // default: the hosted Cloud Function
  timeoutMs: 10_000,                 // per-request timeout
  throwOnError: false,               // see "Graceful failures" below
  feedbackSigningSecret: "...",      // only needed for feedbackUrl()
  fetch: myCustomFetch,              // defaults to globalThis.fetch
});
```

### Base URL resolution

The `baseUrl` option follows this priority order:

1. Explicit `baseUrl` passed to the constructor (highest)
2. `AGENTLOOP_BASE_URL` environment variable
3. Hardcoded Cloud Function URL (fallback)

This lets you point at a local dev server, a self-hosted deployment, or
a future gateway without code changes — just set `AGENTLOOP_BASE_URL` in
the environment. The env var is read through `process.env` when
available (Node, Bun); in browsers and edge runtimes without
`process.env`, it falls back silently to the hardcoded default.

## Three methods

### `search(query, options?)` — before your LLM call

Returns `Memory[]`. Each memory has `{id, fact, score, tags, source, created_at}`.
Cap results with `limit` (max 10). Filter by end-user with `user_id`.
Filter by tag with `tags`.

### `logTurn(question, response, options?)` — after your LLM call

Queues the turn for human review. Pass `signals` to tell AgentLoop why
this turn is interesting:

```ts
await loop.logTurn(question, answer, {
  user_id: "u_123",
  session_id: "sess_abc",
  signals: {
    thumbs_down: true,       // explicit
    factual_claim: true,     // your heuristic
    low_confidence: true,    // model telemetry
    sample: true,            // 15% random sampling
  },
  metadata: { latency_ms: 230, model: "gpt-4o-mini" },
});
```

The backend deduplicates: if 100 customers ask the same question, you
get one review-queue entry with `duplicate_count: 100`, not 100 entries.
The response tells you whether this call was merged:

```ts
const { turn_id, was_duplicate } = await loop.logTurn(q, a, {...});
if (was_duplicate) {
  // Skip any local enrichment you were planning — this turn is already
  // in the queue.
}
```

### `annotate(options)` — direct correction, no review queue

Use this when your application already has a human reviewer inline.
Unlike `search()` and `logTurn()`, `annotate()` **always throws on
failure** — silent degradation would hide the reviewer's work.

```ts
const { annotation_id, memory_id } = await loop.annotate({
  question: "What's the Pix limit at night?",
  agent_response: "R$5,000",
  correction: "Pix limit between 8pm and 6am is R$1,000.",
  rating: "incorrect",
  root_cause: "context",
  tags: ["pix", "limits"],
  reviewer: "maria@luma.com.br",
});
```

## Anthropic example

```ts
import Anthropic from "@anthropic-ai/sdk";

const claude = new Anthropic();

async function ask(question: string, userId: string) {
  const memories = await loop.search(question, { user_id: userId });
  const facts = memories.map((m) => `- ${m.fact}`).join("\n");

  const msg = await claude.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    system: `You are a helpful assistant.\n\nTrusted facts:\n${facts}`,
    messages: [{ role: "user", content: question }],
  });

  const answer = msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");

  await loop.logTurn(question, answer, { user_id: userId });
  return answer;
}
```

## Graceful failures

By default, `search()` returns `[]` and `logTurn()` returns `{}` on any
error — network timeout, HTTP 5xx, whatever. Agent-loop calls sit on the
critical path of your agent's response; a blip on AgentLoop shouldn't
turn into a 500 for your user.

Pass `throwOnError: true` if you'd rather handle failures explicitly:

```ts
const loop = new AgentLoop({ apiKey, throwOnError: true });
try {
  const memories = await loop.search(q);
} catch (err) {
  if (err instanceof AgentLoopError) {
    console.error(`AgentLoop failed: ${err.status} ${err.message}`);
  }
}
```

`annotate()` always throws regardless of this flag — see note above.

## Edge runtimes

Works on Cloudflare Workers, Vercel Edge, and Deno. The SDK uses `fetch`
and Web Crypto only — no Node-specific APIs.

```ts
// Cloudflare Worker
import { AgentLoop } from "@agentloop-sdk/core";

export default {
  async fetch(req: Request, env: Env) {
    const loop = new AgentLoop({ apiKey: env.AGENTLOOP_API_KEY });
    const memories = await loop.search("hello");
    return Response.json({ memories });
  },
};
```

## Feedback widget URLs

If you've configured `FEEDBACK_SIGNING_SECRET` on the backend, you can
generate HMAC-signed URLs for the embedded thumbs-up/down widget:

```ts
const url = await loop.feedbackUrl(question, answer, {
  user_id: "u_123",
  session_id: "sess_abc",
});
// https://agentloop.../feedback?q=...&a=...&sig=...
```

Drop it in a QR code, an `<a href>`, or a delivery SMS. Signatures are
HMAC-SHA256 over a sorted-keys JSON payload — byte-identical to the
Python reference implementation.

## TypeScript

All public types are exported:

```ts
import type {
  AgentLoopOptions,
  Memory,
  LogTurnOptions,
  LogTurnResponse,
  AnnotateOptions,
  AnnotateResponse,
  Rating,
  RootCause,
  TurnSignals,
} from "@agentloop-sdk/core";
```

## License

MIT
