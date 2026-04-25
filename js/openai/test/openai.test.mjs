// Tests for @agentloop-sdk/openai. Uses fake OpenAI client + fake fetch for
// the core SDK's HTTP layer — no real network, no real OpenAI.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "@agentloop-sdk/core";
import { wrapOpenAI, askWithAgentLoop } from "../dist/esm/index.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Minimal OpenAI-shaped client. Captures calls, returns canned responses.
 * Mirrors the bits of OpenAI's real shape we interact with.
 */
function makeFakeOpenAI(handler) {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return handler(params);
        },
      },
    },
    // Other OpenAI namespaces (embeddings, files, etc.) — our Proxy should
    // pass these through unchanged. Include one so the pass-through test
    // has something to verify.
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    },
  };
  return { client, calls };
}

/** Canned non-streaming ChatCompletion. */
function chatCompletion(text) {
  return {
    id: "chatcmpl_fake",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
  };
}

/** Canned streaming iterator that yields chunks. */
function makeStream(chunks) {
  // Mimics OpenAI Stream<ChatCompletionChunk> — has [Symbol.asyncIterator]
  // and a `controller` for aborts.
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function streamChunk(text) {
  return {
    id: "chatcmpl_fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

/**
 * AgentLoop client with a fake fetch. Records every backend call.
 */
function makeFakeLoop() {
  const backendCalls = [];
  const fakeFetch = async (url, init) => {
    backendCalls.push({ url: String(url), init });
    const path = String(url).replace(/^.*agentloop-api/, "");
    if (path.startsWith("/v1/memories/search")) {
      const body = JSON.parse(init.body);
      // Return 1 canned memory per call so injection tests can verify it.
      return new Response(
        JSON.stringify({
          memories: [
            {
              id: "mem_1",
              fact: `Fact relevant to: ${body.query}`,
              score: 0.9,
              tags: [],
              source: "ann_1",
              created_at: "2026-01-01",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (path.startsWith("/v1/turns")) {
      return new Response(
        JSON.stringify({ turn_id: "turn_fake", status: "pending", was_duplicate: false }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 200 });
  };
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fakeFetch });
  return { loop, backendCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("wrapOpenAI: basic pre/post hooks fire on create()", async () => {
  const { client: openai, calls: openaiCalls } = makeFakeOpenAI(() =>
    chatCompletion("hello from gpt")
  );
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  const resp = await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "what is the pix limit?" }],
  });

  // Response shape is passed through untouched.
  assert.equal(resp.choices[0].message.content, "hello from gpt");

  // Pre-hook: search was called with the question.
  const searchCall = backendCalls.find((c) => c.url.includes("/v1/memories/search"));
  assert.ok(searchCall, "search() was not called");
  assert.equal(JSON.parse(searchCall.init.body).query, "what is the pix limit?");

  // The OpenAI call got the memory injected into a new system message.
  const systemMsg = openaiCalls[0].messages.find((m) => m.role === "system");
  assert.ok(systemMsg, "no system message was added");
  assert.ok(
    systemMsg.content.includes("Fact relevant to: what is the pix limit?"),
    "memory not injected into system prompt"
  );

  // Post-hook: logTurn was called with the question and the answer.
  const logCall = backendCalls.find((c) => c.url.includes("/v1/turns"));
  assert.ok(logCall, "logTurn() was not called");
  const logBody = JSON.parse(logCall.init.body);
  assert.equal(logBody.question, "what is the pix limit?");
  assert.equal(logBody.agent_response, "hello from gpt");
});

test("wrapOpenAI: agentloop field is stripped before forwarding to OpenAI", async () => {
  const { client: openai, calls: openaiCalls } = makeFakeOpenAI(() =>
    chatCompletion("ok")
  );
  const { loop } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    agentloop: { userId: "u_123", signals: { thumbs_down: true } },
  });

  // OpenAI got called — agentloop field absent.
  const sent = openaiCalls[0];
  assert.equal(sent.agentloop, undefined, "agentloop leaked into OpenAI params");
  assert.equal(sent.model, "gpt-4o-mini");
});

test("wrapOpenAI: per-call userId is forwarded to both search and logTurn", async () => {
  const { client: openai } = makeFakeOpenAI(() => chatCompletion("ok"));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "q" }],
    agentloop: { userId: "u_abc" },
  });

  const searchBody = JSON.parse(
    backendCalls.find((c) => c.url.includes("/v1/memories/search")).init.body
  );
  const logBody = JSON.parse(
    backendCalls.find((c) => c.url.includes("/v1/turns")).init.body
  );

  assert.equal(searchBody.user_id, "u_abc");
  assert.equal(logBody.user_id, "u_abc");
});

test("wrapOpenAI: skip: true bypasses both search and logTurn", async () => {
  const { client: openai, calls: openaiCalls } = makeFakeOpenAI(() =>
    chatCompletion("ok")
  );
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "health check" }],
    agentloop: { skip: true },
  });

  // OpenAI still called.
  assert.equal(openaiCalls.length, 1);
  // But NO backend calls.
  assert.equal(backendCalls.length, 0);
});

test("wrapOpenAI: search: false skips only retrieval, still logs turn", async () => {
  const { client: openai } = makeFakeOpenAI(() => chatCompletion("ok"));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "q" }],
    agentloop: { search: false },
  });

  assert.equal(
    backendCalls.filter((c) => c.url.includes("/v1/memories/search")).length,
    0,
    "search should have been skipped"
  );
  assert.equal(
    backendCalls.filter((c) => c.url.includes("/v1/turns")).length,
    1,
    "logTurn should still fire"
  );
});

test("wrapOpenAI: signals from detectSignals and per-call merge correctly", async () => {
  const { client: openai } = makeFakeOpenAI(() =>
    chatCompletion("I'm not sure, contact support.")
  );
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, {
    loop,
    detectSignals: (_q, answer) => {
      if (/not sure|contact support/i.test(answer)) return { agent_punted: true };
      return undefined;
    },
  });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "q" }],
    agentloop: { signals: { sample: true } },
  });

  const logBody = JSON.parse(
    backendCalls.find((c) => c.url.includes("/v1/turns")).init.body
  );
  assert.equal(logBody.signals.agent_punted, true, "auto-detected signal missing");
  assert.equal(logBody.signals.sample, true, "per-call signal missing");
});

test("wrapOpenAI: original client is NOT mutated (returns distinct object)", async () => {
  const { client: openai } = makeFakeOpenAI(() => chatCompletion("ok"));
  const originalCreate = openai.chat.completions.create;
  const { loop } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  // Original client's create method is untouched.
  assert.equal(
    openai.chat.completions.create,
    originalCreate,
    "wrapOpenAI mutated the original client"
  );
  // Wrapped proxy's create is different.
  assert.notEqual(
    wrapped.chat.completions.create,
    originalCreate,
    "wrapped client didn't get a new create()"
  );
});

test("wrapOpenAI: non-chat namespaces pass through unchanged", async () => {
  const { client: openai } = makeFakeOpenAI(() => chatCompletion("ok"));
  const { loop } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  // embeddings should go straight through — proxy pass-through.
  const result = await wrapped.embeddings.create({ input: "hi", model: "text-embedding-3-small" });
  assert.deepEqual(result.data[0].embedding, [0.1, 0.2]);
});

test("wrapOpenAI streaming: chunks yield to caller AND logTurn fires with full text", async () => {
  // Build a fake stream that yields 3 chunks.
  const chunks = [streamChunk("Hello, "), streamChunk("world"), streamChunk("!")];
  const { client: openai } = makeFakeOpenAI(() => makeStream(chunks));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop });

  const stream = await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "greet" }],
    stream: true,
    agentloop: { userId: "u_1" },
  });

  // Consume the stream, asserting chunks yield to us in real time.
  const received = [];
  for await (const chunk of stream) {
    received.push(chunk.choices[0].delta.content);
  }
  assert.deepEqual(received, ["Hello, ", "world", "!"]);

  // logTurn was called after the stream closed — wait one microtask for
  // the finally block's fire-and-forget to resolve.
  await new Promise((r) => setImmediate(r));

  const logCall = backendCalls.find((c) => c.url.includes("/v1/turns"));
  assert.ok(logCall, "logTurn not called after stream closed");
  const logBody = JSON.parse(logCall.init.body);
  assert.equal(logBody.agent_response, "Hello, world!", "buffer didn't capture full text");
  assert.equal(logBody.user_id, "u_1");
});

test("askWithAgentLoop: low-level helper works standalone (no Proxy)", async () => {
  const { client: openai } = makeFakeOpenAI(() => chatCompletion("direct"));
  const { loop, backendCalls } = makeFakeLoop();

  const resp = await askWithAgentLoop(
    openai,
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "direct question" }],
    },
    { userId: "u_direct" },
    { loop }
  );

  assert.equal(resp.choices[0].message.content, "direct");
  assert.ok(backendCalls.some((c) => c.url.includes("/v1/memories/search")));
  assert.ok(backendCalls.some((c) => c.url.includes("/v1/turns")));
});

test("wrapOpenAI: custom injectMemories replaces default", async () => {
  const { client: openai, calls: openaiCalls } = makeFakeOpenAI(() =>
    chatCompletion("ok")
  );
  const { loop } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, {
    loop,
    injectMemories: (memories, messages) => {
      // Custom: prepend a context message instead of augmenting system.
      return [
        { role: "user", content: `CONTEXT: ${memories.map((m) => m.fact).join(" | ")}` },
        ...messages,
      ];
    },
  });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "q" }],
  });

  const sent = openaiCalls[0];
  assert.equal(sent.messages[0].role, "user");
  assert.ok(sent.messages[0].content.startsWith("CONTEXT:"));
});

test("wrapOpenAI: onlyLogWhenSignaled: true skips logTurn when no signals", async () => {
  const { client: openai } = makeFakeOpenAI(() => chatCompletion("neutral answer"));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapOpenAI(openai, { loop, onlyLogWhenSignaled: true });

  await wrapped.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "q" }],
  });

  assert.equal(
    backendCalls.filter((c) => c.url.includes("/v1/turns")).length,
    0,
    "logTurn should have been skipped with no signals"
  );
});
