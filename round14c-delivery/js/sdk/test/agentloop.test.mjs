// Tests for @agentloop-sdk/core — run with `node --test test/*.test.mjs`.
//
// Uses Node 18+'s built-in test runner and a hand-rolled fake fetch
// injected via the `fetch` option. No external deps, no real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop, AgentLoopError } from "../dist/esm/index.js";

// ---------------------------------------------------------------------------
// Fake fetch factory
// ---------------------------------------------------------------------------

function makeFakeFetch(handler) {
  // Captures every call so tests can assert on what was sent.
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  fake.calls = calls;
  return fake;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("constructor requires apiKey", () => {
  assert.throws(() => new AgentLoop({}), (err) => err instanceof AgentLoopError);
  assert.throws(() => new AgentLoop({ apiKey: "" }), (err) => err instanceof AgentLoopError);
});

test("constructor strips trailing slash from baseUrl", async () => {
  const fake = makeFakeFetch(() => jsonResponse({ memories: [] }));
  const loop = new AgentLoop({
    apiKey: "ak_test",
    baseUrl: "https://api.example.com///",
    fetch: fake,
  });
  await loop.search("q");
  assert.equal(fake.calls[0].url, "https://api.example.com/v1/memories/search");
});

test("baseUrl: AGENTLOOP_BASE_URL env var is used when options.baseUrl is absent", async () => {
  const previous = process.env.AGENTLOOP_BASE_URL;
  process.env.AGENTLOOP_BASE_URL = "https://env.example.com";
  try {
    const fake = makeFakeFetch(() => jsonResponse({ memories: [] }));
    const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
    await loop.search("q");
    assert.equal(fake.calls[0].url, "https://env.example.com/v1/memories/search");
  } finally {
    if (previous === undefined) delete process.env.AGENTLOOP_BASE_URL;
    else process.env.AGENTLOOP_BASE_URL = previous;
  }
});

test("baseUrl: explicit options.baseUrl overrides AGENTLOOP_BASE_URL env var", async () => {
  const previous = process.env.AGENTLOOP_BASE_URL;
  process.env.AGENTLOOP_BASE_URL = "https://env.example.com";
  try {
    const fake = makeFakeFetch(() => jsonResponse({ memories: [] }));
    const loop = new AgentLoop({
      apiKey: "ak_test",
      baseUrl: "https://explicit.example.com",
      fetch: fake,
    });
    await loop.search("q");
    assert.equal(fake.calls[0].url, "https://explicit.example.com/v1/memories/search");
  } finally {
    if (previous === undefined) delete process.env.AGENTLOOP_BASE_URL;
    else process.env.AGENTLOOP_BASE_URL = previous;
  }
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

test("search() returns memories on success", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({
      memories: [{ id: "mem_1", fact: "test fact", score: 0.9, tags: [], source: "ann_1", created_at: "2026-01-01" }],
    })
  );
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  const result = await loop.search("hello", { user_id: "u1", limit: 5 });
  assert.equal(result.length, 1);
  assert.equal(result[0].fact, "test fact");

  // Verify request shape
  const body = JSON.parse(fake.calls[0].init.body);
  assert.equal(body.query, "hello");
  assert.equal(body.user_id, "u1");
  assert.equal(body.limit, 5);

  // Verify auth header
  assert.equal(fake.calls[0].init.headers.Authorization, "Bearer ak_test");
});

test("search() degrades to [] on network error by default", async () => {
  const fake = makeFakeFetch(() => { throw new Error("network down"); });
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  const result = await loop.search("hello");
  assert.deepEqual(result, []);
});

test("search() throws when throwOnError: true", async () => {
  const fake = makeFakeFetch(() => { throw new Error("network down"); });
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake, throwOnError: true });
  await assert.rejects(() => loop.search("hello"), (err) => err instanceof AgentLoopError);
});

test("search() omits empty tags array from request body", async () => {
  const fake = makeFakeFetch(() => jsonResponse({ memories: [] }));
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  await loop.search("q", { tags: [] });
  const body = JSON.parse(fake.calls[0].init.body);
  assert.equal(body.tags, undefined);
});

// ---------------------------------------------------------------------------
// logTurn()
// ---------------------------------------------------------------------------

test("logTurn() returns response shape including was_duplicate (Round 9)", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({ turn_id: "turn_abc", status: "pending", was_duplicate: true })
  );
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  const result = await loop.logTurn("Q?", "A.", {
    user_id: "u1",
    signals: { thumbs_down: true },
  });
  assert.equal(result.turn_id, "turn_abc");
  assert.equal(result.was_duplicate, true);

  const body = JSON.parse(fake.calls[0].init.body);
  assert.equal(body.question, "Q?");
  assert.equal(body.agent_response, "A.");
  assert.deepEqual(body.signals, { thumbs_down: true });
});

test("logTurn() degrades to {} on error", async () => {
  const fake = makeFakeFetch(() => jsonResponse({ error: "boom" }, 500));
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  const result = await loop.logTurn("Q?", "A.");
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// annotate() — always throws on error
// ---------------------------------------------------------------------------

test("annotate() requires question, agent_response, correction", async () => {
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: makeFakeFetch(() => jsonResponse({})) });
  await assert.rejects(
    () => loop.annotate({ question: "", agent_response: "A", correction: "C", rating: "incorrect" }),
    (err) => err instanceof AgentLoopError
  );
});

test("annotate() throws on HTTP error (does NOT degrade silently)", async () => {
  const fake = makeFakeFetch(() => jsonResponse({ error: "bad request" }, 400));
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  await assert.rejects(
    () => loop.annotate({
      question: "Q", agent_response: "A", correction: "C", rating: "incorrect"
    }),
    (err) => err instanceof AgentLoopError && err.status === 400
  );
});

test("annotate() returns response shape on success", async () => {
  const fake = makeFakeFetch(() =>
    jsonResponse({ annotation_id: "ann_1", memory_id: "mem_1", status: "active" }, 201)
  );
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake });
  const result = await loop.annotate({
    question: "Q", agent_response: "A", correction: "C", rating: "incorrect"
  });
  assert.equal(result.annotation_id, "ann_1");
  assert.equal(result.status, "active");
});

// ---------------------------------------------------------------------------
// feedbackUrl() — HMAC byte-match vs Python reference
// ---------------------------------------------------------------------------

test("feedbackUrl() requires feedbackSigningSecret", async () => {
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: makeFakeFetch(() => jsonResponse({})) });
  await assert.rejects(() => loop.feedbackUrl("q", "a"), (err) => err instanceof AgentLoopError);
});

test("feedbackUrl() produces HMAC signature matching Python reference", async () => {
  // Python reference output for this exact input:
  //   payload = {'q': 'hi', 'a': 'hello', 'u': 'u1', 's': 's1', 't': 1234}
  //   hmac.new(b'secret', json.dumps(payload, sort_keys=True).encode(), hashlib.sha256).hexdigest()
  //   → '1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a'
  const EXPECTED_SIG = "1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a";

  // Freeze Date.now so ts is deterministic.
  const realNow = Date.now;
  Date.now = () => 1234 * 1000;
  try {
    const loop = new AgentLoop({
      apiKey: "ak_test",
      baseUrl: "https://api.example.com",
      feedbackSigningSecret: "secret",
      fetch: makeFakeFetch(() => jsonResponse({})),
    });
    const url = await loop.feedbackUrl("hi", "hello", { user_id: "u1", session_id: "s1" });
    assert.ok(url.includes(`sig=${EXPECTED_SIG}`), `expected sig in ${url}`);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// AgentLoopError
// ---------------------------------------------------------------------------

test("AgentLoopError exposes status and body", async () => {
  const fake = makeFakeFetch(() => jsonResponse({ error: "nope" }, 403));
  const loop = new AgentLoop({ apiKey: "ak_test", fetch: fake, throwOnError: true });
  try {
    await loop.search("q");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof AgentLoopError);
    assert.equal(err.status, 403);
    assert.equal(err.message, "nope");
    assert.ok(err.body.includes("nope"));
  }
});
