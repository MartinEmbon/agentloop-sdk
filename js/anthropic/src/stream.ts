/**
 * Streaming path for Anthropic. Accumulates assistant text from
 * `content_block_delta` events (where delta.type === "text_delta") and
 * fires logTurn once the stream closes.
 *
 * Anthropic emits a richer event stream than OpenAI:
 *   message_start, content_block_start, content_block_delta (×N),
 *   content_block_stop, message_delta, message_stop
 *
 * We re-yield every event unchanged (callers often depend on seeing
 * all events, not just deltas), and watch the deltas for text we
 * should accumulate.
 */

import type { AgentLoop, Memory, TurnSignals } from "@agentloop-sdk/core";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  MessageStreamEvent,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { Stream } from "@anthropic-ai/sdk/streaming";

import type { AgentLoopAnthropicOptions, PerCallOptions } from "./ask.js";

// Helpers duplicated so this module is importable standalone.
function extractQuestion(messages: MessageParam[]): string {
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
  existingSystem: string | TextBlockParam[] | undefined
): string | TextBlockParam[] | undefined {
  if (memories.length === 0) return existingSystem;
  const factsBlock =
    "\n\nTrusted facts from past corrections:\n" +
    memories.map((m) => `- ${m.fact}`).join("\n");
  if (existingSystem === undefined) {
    return "You are a helpful assistant." + factsBlock;
  }
  if (typeof existingSystem === "string") {
    return existingSystem + factsBlock;
  }
  const updated = [...existingSystem];
  const lastTextIdx = updated.map((b, i) => ({ b, i }))
    .reverse()
    .find(({ b }) => b.type === "text")?.i;
  if (lastTextIdx !== undefined) {
    const block = updated[lastTextIdx];
    if (block && block.type === "text") {
      updated[lastTextIdx] = { ...block, text: block.text + factsBlock };
    }
  } else {
    updated.push({ type: "text", text: factsBlock });
  }
  return updated;
}

export async function askWithAgentLoopStream(
  client: Anthropic,
  params: MessageCreateParamsStreaming,
  perCall: PerCallOptions | undefined,
  config: AgentLoopAnthropicOptions
): Promise<Stream<MessageStreamEvent>> {
  if (perCall?.skip) {
    return client.messages.create(params);
  }

  const question = extractQuestion(params.messages);

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

  const injector = config.injectMemories ?? defaultInjectMemories;
  const newSystem = injector(memories, params.system);

  const sourceStream = await client.messages.create({
    ...params,
    ...(newSystem !== undefined && { system: newSystem }),
  });

  return wrapStream(sourceStream, question, memories, perCall, config);
}

function wrapStream(
  source: Stream<MessageStreamEvent>,
  question: string,
  memories: Memory[],
  perCall: PerCallOptions | undefined,
  config: AgentLoopAnthropicOptions
): Stream<MessageStreamEvent> {
  let accumulated = "";
  let logFired = false;

  const fireLog = async () => {
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

  async function* wrappedIterator(): AsyncGenerator<MessageStreamEvent> {
    try {
      for await (const event of source) {
        // Accumulate text from content_block_delta events where the
        // delta is a text_delta. Other event types pass through
        // unchanged (tool_use deltas, message metadata, etc.).
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          accumulated += event.delta.text;
        }
        yield event;
      }
    } finally {
      fireLog().catch(() => { /* swallow — logTurn failures shouldn't affect caller */ });
    }
  }

  const wrapped = {
    [Symbol.asyncIterator]: wrappedIterator,
    controller: (source as Stream<MessageStreamEvent> & { controller?: AbortController }).controller,
  };

  return wrapped as unknown as Stream<MessageStreamEvent>;
}
