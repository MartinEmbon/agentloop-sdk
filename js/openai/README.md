# @agentloop-sdk/openai

Drop-in wrapper that adds [AgentLoop](https://agentloop.dev) memory
retrieval and turn logging to every `openai.chat.completions.create` call.

```ts
import OpenAI from "openai";
import { AgentLoop } from "@agentloop-sdk/core";
import { wrapOpenAI } from "@agentloop-sdk/openai";

const openai = wrapOpenAI(new OpenAI(), {
  loop: new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! }),
});

// Use exactly like the normal OpenAI SDK.
// Memory search fires before; logTurn fires after.
const resp = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "What's the Pix limit at night?" }],
});
```

That's the whole integration.

## What happens under the hood

For every `chat.completions.create` call, the wrapper:

1. Extracts the last user message as the query
2. Calls `loop.search(query)` — pulls any relevant corrections
3. Injects them into your system prompt (or creates one if absent)
4. Calls OpenAI with the augmented messages
5. Calls `loop.logTurn(question, answer)` with the result

If either AgentLoop call fails, your OpenAI call still succeeds. Hooks
degrade gracefully — AgentLoop sits on the critical path of your agent's
response and a blip shouldn't turn into a 500.

## Install

```bash
npm install @agentloop-sdk/core @agentloop-sdk/openai openai
```

All three are required. `openai` and `@agentloop-sdk/core` are peer deps so
you pick the versions.

## Per-call options

Pass an `agentloop` field alongside your normal OpenAI params. The
wrapper strips it before forwarding (OpenAI rejects unknown top-level
fields).

```ts
const resp = await openai.chat.completions.create({
  model: "gpt-4o-mini",
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

Streaming works — chunks yield to the caller in real time while the
wrapper buffers the full answer and fires `logTurn` after the stream
closes.

```ts
const stream = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: question }],
  stream: true,
  agentloop: { userId: "u_123" },
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
// logTurn has already fired with the full assembled text.
```

Early termination (breaking out of the loop, an abort signal) still
triggers logTurn with whatever was generated.

## Configuration (passed at wrap time)

```ts
const openai = wrapOpenAI(new OpenAI(), {
  loop,

  // How to inject memories into messages. Default: append to system
  // prompt with a "Trusted facts from past corrections:" block.
  injectMemories: (memories, messages) => [...],

  // Auto-detect signals from the response before logTurn.
  detectSignals: (question, answer, memories) => ({
    agent_punted: /not sure|contact support/i.test(answer),
    factual_claim: /\$|%|\d+\s*(day|hour|week)/i.test(answer),
  }),

  // Max memories per call. Default 3. Backend caps at 10.
  searchLimit: 3,

  // Apply these tags to every memory search.
  searchTags: ["production"],

  // If true, logTurn fires only when at least one signal triggered.
  // Default false — log every turn so reviewers see baseline behavior.
  onlyLogWhenSignaled: false,
});
```

## Low-level API

For callers who want explicit control (custom streaming, non-chat
endpoints, conditional wrapping), `askWithAgentLoop` is the underlying
helper:

```ts
import { askWithAgentLoop } from "@agentloop-sdk/openai";

const resp = await askWithAgentLoop(
  openai,                        // a raw, unwrapped OpenAI client
  {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: question }],
  },
  { userId: "u_123" },           // per-call options
  { loop }                       // wrap-time config
);
```

The Proxy wrapper is built on top of this — same semantics, more
verbose call site.

## Not mutated

`wrapOpenAI(client)` returns a distinct Proxy. Your original client
stays unwrapped and usable.

```ts
const raw = new OpenAI();
const wrapped = wrapOpenAI(raw, { loop });

await raw.chat.completions.create({...});       // no AgentLoop hooks
await wrapped.chat.completions.create({...});   // with AgentLoop hooks
```

## License

MIT
