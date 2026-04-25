// Tests for @agentloop-sdk/anthropic. Mirrors the @agentloop-sdk/openai test
// structure — fake Anthropic client, fake fetch on the core SDK,
// covers the same scenarios adapted for Anthropic's API shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "@agentloop-sdk/core";
import { wrapAnthropic, askWithAgentLoop } from "../dist/esm/index.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeAnthropic(handler) {
  const calls = [];
  const client = {
    messages: {
      create: async (params) => {
        calls.push(params);
        return handler(params);
      },
    },
    // Other namespaces (completions, models) should pass through.
    models: {
      list: async () => ({ data: [{ id: "claude-opus-4-7" }] }),
    },
  };
  return { client, calls };
}

/** Canned non-streaming Message. */
function message(text) {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** Canned streaming events. Mirrors Anthropic's real event sequence. */
function makeStream(textPieces) {
  const events = [
    { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-4-7", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...textPieces.map((t) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: t },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

function makeFakeLoop() {
  const backendCalls = [];
  const fakeFetch = async (url, init) => {
    backendCalls.push({ url: String(url), init });
    const path = String(url).replace(/^.*agentloop-api/, "");
    if (path.startsWith("/v1/memories/search")) {
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          memories: [
            { id: "mem_1", fact: `Fact relevant to: ${body.query}`, score: 0.9, tags: [], source: "ann_1", created_at: "2026-01-01" },
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

test("wrapAnthropic: pre/post hooks fire on messages.create()", async () => {
  const { client, calls: anthropicCalls } = makeFakeAnthropic(() => message("reply"));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });

  const resp = await wrapped.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: "what is the pix limit?" }],
  });

  assert.equal(resp.content[0].text, "reply");

  const searchCall = backendCalls.find((c) => c.url.includes("/v1/memories/search"));
  assert.ok(searchCall);
  assert.equal(JSON.parse(searchCall.init.body).query, "what is the pix limit?");

  // Memory injected into system prompt (which started as undefined, so
  // the default injector created one starting with "You are a helpful
  // assistant.")
  const sent = anthropicCalls[0];
  assert.ok(
    typeof sent.system === "string" && sent.system.includes("Fact relevant to: what is the pix limit?"),
    `memory not injected; got system=${JSON.stringify(sent.system)}`
  );

  const logCall = backendCalls.find((c) => c.url.includes("/v1/turns"));
  assert.ok(logCall);
  const logBody = JSON.parse(logCall.init.body);
  assert.equal(logBody.question, "what is the pix limit?");
  assert.equal(logBody.agent_response, "reply");
});

test("wrapAnthropic: existing string system prompt gets appended to", async () => {
  const { client, calls: anthropicCalls } = makeFakeAnthropic(() => message("ok"));
  const { loop } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });

  await wrapped.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 100,
    system: "You are a Luma customer support bot.",
    messages: [{ role: "user", content: "q" }],
  });

  const sent = anthropicCalls[0];
  assert.ok(typeof sent.system === "string");
  assert.ok(sent.system.startsWith("You are a Luma customer support bot."));
  assert.ok(sent.system.includes("Trusted facts from past corrections"));
});

test("wrapAnthropic: agentloop field is stripped before forwarding", async () => {
  const { client, calls: anthropicCalls } = makeFakeAnthropic(() => message("ok"));
  const { loop } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });

  await wrapped.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    agentloop: { userId: "u_123", signals: { thumbs_down: true } },
  });

  assert.equal(anthropicCalls[0].agentloop, undefined);
  assert.equal(anthropicCalls[0].model, "claude-opus-4-7");
});

test("wrapAnthropic: skip: true bypasses both search and logTurn", async () => {
  const { client, calls: anthropicCalls } = makeFakeAnthropic(() => message("ok"));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });

  await wrapped.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 100,
    messages: [{ role: "user", content: "health check" }],
    agentloop: { skip: true },
  });

  assert.equal(anthropicCalls.length, 1);
  assert.equal(backendCalls.length, 0);
});

test("wrapAnthropic: original client is NOT mutated", async () => {
  const { client } = makeFakeAnthropic(() => message("ok"));
  const originalCreate = client.messages.create;
  const { loop } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });

  assert.equal(client.messages.create, originalCreate, "original mutated");
  assert.notEqual(wrapped.messages.create, originalCreate);
});

test("wrapAnthropic: non-messages namespaces pass through", async () => {
  const { client } = makeFakeAnthropic(() => message("ok"));
  const { loop } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });
  const models = await wrapped.models.list();
  assert.equal(models.data[0].id, "claude-opus-4-7");
});

test("wrapAnthropic streaming: text accumulates from content_block_delta events", async () => {
  const { client } = makeFakeAnthropic(() => makeStream(["Hello, ", "world", "!"]));
  const { loop, backendCalls } = makeFakeLoop();

  const wrapped = wrapAnthropic(client, { loop });

  const stream = await wrapped.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 100,
    messages: [{ role: "user", content: "greet" }],
    stream: true,
    agentloop: { userId: "u_1" },
  });

  // Consume stream — verify we get ALL events, not just text_deltas.
  const eventTypes = [];
  const textPieces = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      textPieces.push(event.delta.text);
    }
  }
  assert.ok(eventTypes.includes("message_start"));
  assert.ok(eventTypes.includes("content_block_stop"));
  assert.ok(eventTypes.includes("message_stop"));
  assert.deepEqual(textPieces, ["Hello, ", "world", "!"]);

  // Wait for fire-and-forget logTurn
  await new Promise((r) => setImmediate(r));

  const logCall = backendCalls.find((c) => c.url.includes("/v1/turns"));
  assert.ok(logCall);
  const logBody = JSON.parse(logCall.init.body);
  assert.equal(logBody.agent_response, "Hello, world!");
  assert.equal(logBody.user_id, "u_1");
});

test("askWithAgentLoop: standalone low-level helper", async () => {
  const { client } = makeFakeAnthropic(() => message("direct"));
  const { loop, backendCalls } = makeFakeLoop();

  const resp = await askWithAgentLoop(
    client,
    {
      model: "claude-opus-4-7",
      max_tokens: 100,
      messages: [{ role: "user", content: "direct question" }],
    },
    { userId: "u_direct" },
    { loop }
  );

  assert.equal(resp.content[0].text, "direct");
  assert.ok(backendCalls.some((c) => c.url.includes("/v1/memories/search")));
  assert.ok(backendCalls.some((c) => c.url.includes("/v1/turns")));
});
