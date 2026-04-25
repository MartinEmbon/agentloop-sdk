/**
 * Core helper that wraps a single OpenAI chat-completions call in the
 * full AgentLoop cycle: search → inject → call → logTurn.
 *
 * This is the low-level API the Proxy wrapper builds on. Exported
 * directly for callers who want explicit control — custom signal
 * detection, non-chat endpoints, conditional skipping, etc.
 *
 * Keeps no state: each call is independent. Same function handles
 * multi-turn chats (caller passes the full message history) — we only
 * retrieve against the last user message, which matches how chatbots
 * actually get used.
 */

import type { AgentLoop, Memory, TurnSignals } from "@agentloop-sdk/core";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type OpenAI from "openai";

/**
 * Extra options a caller can pass per-call alongside their normal OpenAI
 * chat-completions params. Everything here is optional; a call with no
 * `agentloop` field at all still works (config from `wrapOpenAI` applies).
 */
export interface PerCallOptions {
  /** Scope memory search to this end-user (matches signals.user_id). */
  userId?: string;
  /** Pass through to logTurn() unchanged. */
  sessionId?: string;
  /**
   * Signals to attach to the logged turn. Merged on top of any signals
   * auto-detected by the wrapper (see `detectSignals` option).
   */
  signals?: TurnSignals;
  /** Arbitrary metadata stored with the turn. */
  metadata?: Record<string, unknown>;
  /**
   * Skip the AgentLoop pre/post hooks for this specific call. Useful for
   * system messages, health checks, or any call you don't want reviewed.
   * The underlying OpenAI call still runs normally.
   */
  skip?: boolean;
  /**
   * Override the memory search behavior for this call.
   * - `undefined` (default): use the default (search on, inject on, up to 3)
   * - `false`: don't search for this call
   * - a shape: override the defaults
   */
  search?: false | { limit?: number; tags?: string[] };
}

/**
 * Configuration for `askWithAgentLoop` and for `wrapOpenAI`. Same shape
 * because the wrapper stores these and passes them through.
 */
export interface AgentLoopOpenAIOptions {
  /** The AgentLoop client. Required. */
  loop: AgentLoop;
  /**
   * How to inject retrieved memories into the system prompt. Default
   * prepends an "Trusted facts from past corrections:" block to the first
   * system message (or creates one if absent). Override for a different
   * format, different position, different language.
   */
  injectMemories?: (memories: Memory[], messages: ChatCompletionMessageParam[]) => ChatCompletionMessageParam[];
  /**
   * Auto-detect signals from the assistant's response. Runs after the
   * LLM call, before logTurn. Return `undefined` to skip auto-detection.
   * Merged with any per-call signals the caller passed.
   */
  detectSignals?: (question: string, answer: string, memories: Memory[]) => TurnSignals | undefined;
  /**
   * How many memories to retrieve per call by default. Override per-call
   * via `agentloop.search.limit`. Defaults to 3.
   */
  searchLimit?: number;
  /**
   * Tags to apply to every memory search. Override per-call via
   * `agentloop.search.tags`.
   */
  searchTags?: string[];
  /**
   * If true, logTurn() is skipped when no signals fired AND no random
   * sample rate triggered. Default false — we log every turn so reviewers
   * see baseline agent behavior, not just failures. Set true for
   * high-traffic apps where you only want to see flagged turns.
   */
  onlyLogWhenSignaled?: boolean;
}

// ---------------------------------------------------------------------------
// Default injection: prepend a "Trusted facts" block to system prompt.
// ---------------------------------------------------------------------------

function defaultInjectMemories(
  memories: Memory[],
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  if (memories.length === 0) return messages;

  const factsBlock =
    "\n\nTrusted facts from past corrections:\n" +
    memories.map((m) => `- ${m.fact}`).join("\n");

  // Find the first system message and append; if none exists, prepend one.
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
    updated[firstSystemIdx] = {
      ...systemMsg,
      content: existingContent + factsBlock,
    };
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Extract the "question" from a chat messages array — the last user msg.
// ---------------------------------------------------------------------------

function extractQuestion(messages: ChatCompletionMessageParam[]): string {
  // Scan backwards for the most recent user message. Tool/assistant/system
  // messages in between are part of the conversation scaffolding, not the
  // question we want to retrieve against.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content;
      // Multi-part messages: concatenate text parts. (Image parts skipped
      // — we don't have a story for multimodal memory retrieval yet.)
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
// Extract the answer text from a ChatCompletion response.
// ---------------------------------------------------------------------------

export function extractAnswer(completion: ChatCompletion): string {
  const msg = completion.choices[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return "";
}

// ---------------------------------------------------------------------------
// Main entry point (non-streaming).
// ---------------------------------------------------------------------------

export async function askWithAgentLoop(
  openai: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  perCall: PerCallOptions | undefined,
  config: AgentLoopOpenAIOptions
): Promise<ChatCompletion> {
  if (perCall?.skip) {
    // Full bypass — no search, no logTurn, pure passthrough.
    return openai.chat.completions.create(params);
  }

  const question = extractQuestion(params.messages as ChatCompletionMessageParam[]);

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

  // ---- 2. Inject into prompt ----
  const injector = config.injectMemories ?? defaultInjectMemories;
  const augmentedMessages = injector(
    memories,
    params.messages as ChatCompletionMessageParam[]
  );

  // ---- 3. Call the LLM ----
  const completion = await openai.chat.completions.create({
    ...params,
    messages: augmentedMessages,
  });
  const answer = extractAnswer(completion);

  // ---- 4. Detect signals + log ----
  const autoSignals = config.detectSignals
    ? config.detectSignals(question, answer, memories) ?? {}
    : {};
  const mergedSignals: TurnSignals = { ...autoSignals, ...(perCall?.signals ?? {}) };

  const shouldLog =
    !config.onlyLogWhenSignaled || Object.keys(mergedSignals).length > 0;

  if (shouldLog && question && answer) {
    // Fire-and-forget. logTurn already degrades gracefully on error, so
    // awaiting this only delays the return; not awaiting would lose
    // backpressure and make testing harder. We await.
    await config.loop.logTurn(question, answer, {
      ...(perCall?.userId && { user_id: perCall.userId }),
      ...(perCall?.sessionId && { session_id: perCall.sessionId }),
      ...(Object.keys(mergedSignals).length > 0 && { signals: mergedSignals }),
      ...(perCall?.metadata && { metadata: perCall.metadata }),
    });
  }

  return completion;
}
