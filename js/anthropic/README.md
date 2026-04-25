# @agentloop-sdk/anthropic

Drop-in wrapper that adds [AgentLoop](https://agentloop.dev) memory
retrieval and turn logging to every `anthropic.messages.create` call.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AgentLoop } from "@agentloop-sdk/core";
import { wrapAnthropic } from "@agentloop-sdk/anthropic";

const anthropic = wrapAnthropic(new Anthropic(), {
  loop: new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! }),
});

// Use exactly like the normal Anthropic SDK.
// Memory search fires before; logTurn fires after.
const msg = await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What's the Pix limit at night?" }],
});
```

That's the whole integration.

## What happens under the hood

For every `messages.create` call, the wrapper:

1. Extracts the last user message as the query
2. Calls `loop.search(query)` — pulls any relevant corrections
3. Appends them to your `system` prompt (or creates one if absent)
4. Calls Anthropic with the augmented system prompt
5. Calls `loop.logTurn(question, answer)` with the assembled text

If either AgentLoop call fails, your Anthropic call still succeeds —
the hooks degrade gracefully.

## Install

```bash
npm install @agentloop-sdk/core @agentloop-sdk/anthropic @anthropic-ai/sdk
```

All three are required. `@anthropic-ai/sdk` and `@agentloop-sdk/core` are
peer deps so you pick the versions.

## Per-call options

Pass an `agentloop` field alongside your normal Anthropic params. The
wrapper strips it before forwarding (Anthropic rejects unknown fields).

```ts
const msg = await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [...],
  agentloop: {
    userId: "u_123",                         // scope memory search + logTurn
    sessionId: "sess_abc",                   // passed to logTurn
    signals: { thumbs_down: true },          // merged with auto-detected
    metadata: { latency_budget_ms: 500 },    // stored with the turn
    skip: false,                             // true = bypass AgentLoop entirely
    search: false,                           // skip only retrieval (still logs)
    // or search: { limit: 5, tags: ["pix"] }
  },
});
```

## Streaming

Streaming works — events yield to the caller in real time while the
wrapper buffers text from `content_block_delta` events and fires
`logTurn` after `message_stop`.

```ts
const stream = await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: question }],
  stream: true,
  agentloop: { userId: "u_123" },
});

for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
}
// logTurn has already fired with the full assembled text.
```

The wrapper yields every event type unchanged (`message_start`,
`content_block_start`, `content_block_delta`, `content_block_stop`,
`message_delta`, `message_stop`) — callers that depend on non-text
events continue to work.

## Configuration (passed at wrap time)

```ts
const anthropic = wrapAnthropic(new Anthropic(), {
  loop,

  // How to merge memories into the system prompt. Default appends a
  // "Trusted facts from past corrections:" block to a string system,
  // or to the last text block if system was an array.
  injectMemories: (memories, existingSystem) => {...},

  // Auto-detect signals from the response before logTurn.
  detectSignals: (question, answer, memories) => ({
    agent_punted: /not sure|contact support/i.test(answer),
    factual_claim: /\$|%|\d+\s*(day|hour|week)/i.test(answer),
  }),

  // Max memories per call. Default 3.
  searchLimit: 3,

  // Apply these tags to every memory search.
  searchTags: ["production"],

  // Only log turns when at least one signal fired. Default false.
  onlyLogWhenSignaled: false,
});
```

## Low-level API

```ts
import { askWithAgentLoop } from "@agentloop-sdk/anthropic";

const resp = await askWithAgentLoop(
  anthropic,                    // raw, unwrapped Anthropic client
  {
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: question }],
  },
  { userId: "u_123" },          // per-call options
  { loop }                      // wrap-time config
);
```

## Not mutated

`wrapAnthropic(client)` returns a distinct Proxy. Your original client
stays unwrapped and usable.

## License

MIT
