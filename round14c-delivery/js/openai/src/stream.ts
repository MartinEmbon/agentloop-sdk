/**
 * Streaming path for askWithAgentLoop.
 *
 * The tricky bit: callers want chunks yielded in real time (that's the
 * whole point of streaming) AND we need the full answer text to fire
 * logTurn() after the stream closes. Solution: re-yield each chunk as
 * it arrives, accumulate its text into a local string, and fire logTurn
 * in a finally-block once the stream is exhausted or aborted.
 *
 * Early termination is important. If the caller breaks out of the
 * for-await loop (user navigated away, abort signal fired, etc.), we
 * still want logTurn to fire with whatever text was generated. The
 * finally block guarantees this.
 */

import type { AgentLoop, Memory, TurnSignals } from "@agentloop-sdk/core";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import type OpenAI from "openai";

import type { AgentLoopOpenAIOptions, PerCallOptions } from "./ask.js";

// ---------------------------------------------------------------------------
// Helpers (same as ask.ts — duplicated to keep modules independently importable)
// ---------------------------------------------------------------------------

function extractQuestion(messages: ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
    }
  }
  return "";
}

function defaultInjectMemories(
  memories: Memory[],
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  if (memories.length === 0) return messages;
  const factsBlock =
    "\n\nTrusted facts from past corrections:\n" +
    memories.map((m) => `- ${m.fact}`).join("\n");
  const firstSystemIdx = messages.findIndex((m) => m.role === "system");
  if (firstSystemIdx === -1) {
    return [
      { role: "system", content: "You are a helpful assistant." + factsBlock },
      ...messages,
    ];
  }
  const updated = [...messages];
  const systemMsg = updated[firstSystemIdx];
  if (systemMsg && systemMsg.role === "system") {
    const existingContent =
      typeof systemMsg.content === "string" ? systemMsg.content : "";
    updated[firstSystemIdx] = { ...systemMsg, content: existingContent + factsBlock };
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Buffered stream proxy
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenAI stream so chunks yield to the caller while we
 * accumulate the assistant's text for logTurn.
 *
 * Returns an async-iterable that proxies the original stream. The
 * proxy's return type matches OpenAI's Stream interface at the iterable
 * level — good enough for `for await` consumers, which is how 99% of
 * streaming is used.
 */
export async function askWithAgentLoopStream(
  openai: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  perCall: PerCallOptions | undefined,
  config: AgentLoopOpenAIOptions
): Promise<Stream<ChatCompletionChunk>> {
  if (perCall?.skip) {
    // Passthrough — no search, no logTurn, caller sees the raw stream.
    return openai.chat.completions.create(params);
  }

  const question = extractQuestion(params.messages as ChatCompletionMessageParam[]);

  // ---- 1. Retrieve memories (same as non-streaming) ----
  let memories: Memory[] = [];
  if (perCall?.search !== false && question) {
    const searchLimit =
      (perCall?.search && perCall.search.limit) ?? config.searchLimit ?? 3;
    const searchTags =
      (perCall?.search && perCall.search.tags) ?? config.searchTags;
    memories = await config.loop.search(question, {
      limit: searchLimit,
      ...(perCall?.userId && { user_id: perCall.userId }),
      ...(searchTags && searchTags.length > 0 && { tags: searchTags }),
    });
  }

  // ---- 2. Inject into prompt ----
  const injector = config.injectMemories ?? defaultInjectMemories;
  const augmentedMessages = injector(
    memories,
    params.messages as ChatCompletionMessageParam[]
  );

  // ---- 3. Start the stream ----
  const sourceStream = await openai.chat.completions.create({
    ...params,
    messages: augmentedMessages,
  });

  // ---- 4. Wrap the stream so we can buffer + log on completion ----
  return wrapStream(sourceStream, question, memories, perCall, config);
}

function wrapStream(
  source: Stream<ChatCompletionChunk>,
  question: string,
  memories: Memory[],
  perCall: PerCallOptions | undefined,
  config: AgentLoopOpenAIOptions
): Stream<ChatCompletionChunk> {
  // Accumulator for assistant's text across all chunks.
  let accumulated = "";
  let logFired = false;

  const fireLog = async () => {
    // Idempotent — can be called from both the finally block and an early
    // stream close. Guarded by logFired so we never double-log.
    if (logFired) return;
    logFired = true;

    const autoSignals = config.detectSignals
      ? config.detectSignals(question, accumulated, memories) ?? {}
      : {};
    const mergedSignals: TurnSignals = {
      ...autoSignals,
      ...(perCall?.signals ?? {}),
    };

    const shouldLog =
      !config.onlyLogWhenSignaled || Object.keys(mergedSignals).length > 0;

    if (shouldLog && question && accumulated) {
      await config.loop.logTurn(question, accumulated, {
        ...(perCall?.userId && { user_id: perCall.userId }),
        ...(perCall?.sessionId && { session_id: perCall.sessionId }),
        ...(Object.keys(mergedSignals).length > 0 && { signals: mergedSignals }),
        ...(perCall?.metadata && { metadata: perCall.metadata }),
      });
    }
  };

  // Build the wrapped async iterator. We wrap the source's `[Symbol.asyncIterator]`
  // and intercept each chunk to accumulate text. The finally block fires
  // logTurn even if the caller breaks out of the loop early.
  async function* wrappedIterator(): AsyncGenerator<ChatCompletionChunk> {
    try {
      for await (const chunk of source) {
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === "string") accumulated += delta;
        yield chunk;
      }
    } finally {
      // Fire-and-forget the log. We don't await inside finally because
      // that would block the caller's for-await cleanup on a network
      // round-trip. logTurn already degrades gracefully on error.
      fireLog().catch(() => { /* swallow — logTurn failures shouldn't affect caller */ });
    }
  }

  // Return an object that is assignable to Stream<ChatCompletionChunk>.
  // We preserve the source's `.controller` for abort support and delegate
  // everything else through the wrapped iterator.
  const wrapped = {
    [Symbol.asyncIterator]: wrappedIterator,
    // Pass through abort control so callers can still cancel.
    controller: (source as Stream<ChatCompletionChunk> & { controller?: AbortController }).controller,
    // tee/toReadableStream are advanced OpenAI-stream APIs; delegate if the
    // source has them. Most callers only use for-await so this is
    // typically fine.
    tee: (source as unknown as { tee?: () => [unknown, unknown] }).tee?.bind(source),
    toReadableStream: (source as unknown as { toReadableStream?: () => ReadableStream }).toReadableStream?.bind(source),
  };

  return wrapped as unknown as Stream<ChatCompletionChunk>;
}
