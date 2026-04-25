/**
 * Core helper that wraps a single Anthropic messages.create call in the
 * full AgentLoop cycle: search → inject → call → logTurn.
 *
 * Anthropic's API is structurally different from OpenAI:
 * - system prompt lives on a top-level `system` field (not a role)
 * - response.content is an array of blocks (text, tool_use, etc.)
 * - text extraction requires filter+map
 *
 * But the AgentLoop semantics are identical: retrieve relevant
 * corrections, inject into the system prompt, call the LLM, log the
 * turn.
 */

import type { AgentLoop, Memory, TurnSignals } from "@agentloop-sdk/core";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Message,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

/**
 * Extra options a caller can pass per-call. Same shape as @agentloop-sdk/openai's
 * PerCallOptions — intentional, so callers who use both wrappers can share
 * option objects.
 */
export interface PerCallOptions {
  userId?: string;
  sessionId?: string;
  signals?: TurnSignals;
  metadata?: Record<string, unknown>;
  skip?: boolean;
  search?: false | { limit?: number; tags?: string[] };
}

export interface AgentLoopAnthropicOptions {
  loop: AgentLoop;
  /**
   * How to build the system prompt given retrieved memories. Receives
   * whatever the caller passed as `system` (possibly undefined) plus
   * the memories, returns the new system value to forward to Anthropic.
   *
   * Default: append a "Trusted facts from past corrections:" block to
   * the existing string system prompt, or concatenate onto the last
   * text block if system was an array.
   */
  injectMemories?: (
    memories: Memory[],
    existingSystem: string | TextBlockParam[] | undefined
  ) => string | TextBlockParam[] | undefined;
  detectSignals?: (question: string, answer: string, memories: Memory[]) => TurnSignals | undefined;
  searchLimit?: number;
  searchTags?: string[];
  onlyLogWhenSignaled?: boolean;
}

// ---------------------------------------------------------------------------
// Default injector — append to system prompt.
// ---------------------------------------------------------------------------

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

  // Array form — append to the last text block, or add a new one.
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

// ---------------------------------------------------------------------------
// Question extraction — last user message, text content only.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Answer extraction — concatenate text blocks from the response.
// ---------------------------------------------------------------------------

export function extractAnswer(message: Message): string {
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");
}

// ---------------------------------------------------------------------------
// Main entry point (non-streaming).
// ---------------------------------------------------------------------------

export async function askWithAgentLoop(
  client: Anthropic,
  params: MessageCreateParamsNonStreaming,
  perCall: PerCallOptions | undefined,
  config: AgentLoopAnthropicOptions
): Promise<Message> {
  if (perCall?.skip) {
    return client.messages.create(params);
  }

  const question = extractQuestion(params.messages);

  // ---- 1. Retrieve memories ----
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

  // ---- 2. Inject memories into system prompt ----
  const injector = config.injectMemories ?? defaultInjectMemories;
  const newSystem = injector(memories, params.system);

  // ---- 3. Call Anthropic ----
  const message = await client.messages.create({
    ...params,
    ...(newSystem !== undefined && { system: newSystem }),
  });
  const answer = extractAnswer(message);

  // ---- 4. Detect signals + log ----
  const autoSignals = config.detectSignals
    ? config.detectSignals(question, answer, memories) ?? {}
    : {};
  const mergedSignals: TurnSignals = { ...autoSignals, ...(perCall?.signals ?? {}) };

  const shouldLog =
    !config.onlyLogWhenSignaled || Object.keys(mergedSignals).length > 0;

  if (shouldLog && question && answer) {
    await config.loop.logTurn(question, answer, {
      ...(perCall?.userId && { user_id: perCall.userId }),
      ...(perCall?.sessionId && { session_id: perCall.sessionId }),
      ...(Object.keys(mergedSignals).length > 0 && { signals: mergedSignals }),
      ...(perCall?.metadata && { metadata: perCall.metadata }),
    });
  }

  return message;
}
