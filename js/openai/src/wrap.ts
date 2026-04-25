/**
 * wrapOpenAI — the drop-in proxy wrapper.
 *
 * Returns a Proxy around the OpenAI client that intercepts
 * `chat.completions.create` calls and routes them through AgentLoop.
 * Every other path (openai.embeddings, openai.files, etc.) passes
 * through unchanged.
 *
 * Per-call options are passed via a dedicated `agentloop` field on the
 * create() params object. The wrapper strips that field before
 * forwarding to OpenAI, which rejects unknown top-level fields.
 */

import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";

import { askWithAgentLoop } from "./ask.js";
import { askWithAgentLoopStream } from "./stream.js";
import type { AgentLoopOpenAIOptions, PerCallOptions } from "./ask.js";

/**
 * Augmented params accepted by the wrapped client. Same as OpenAI's
 * normal params plus an `agentloop` field for per-call overrides.
 */
export type WrappedCreateParams =
  | (ChatCompletionCreateParamsNonStreaming & { agentloop?: PerCallOptions })
  | (ChatCompletionCreateParamsStreaming & { agentloop?: PerCallOptions });

/**
 * Wrap an OpenAI client so chat.completions.create calls fire
 * AgentLoop pre/post hooks automatically.
 *
 * The returned object is typed as OpenAI for drop-in compatibility.
 * The only observable difference: create() accepts an extra `agentloop`
 * field for per-call overrides.
 *
 * @example
 *   const openai = wrapOpenAI(new OpenAI(), { loop });
 *   const resp = await openai.chat.completions.create({
 *     model: "gpt-4o-mini",
 *     messages: [{ role: "user", content: "hello" }],
 *     agentloop: { userId: "u_123" },
 *   });
 */
export function wrapOpenAI(
  client: OpenAI,
  config: AgentLoopOpenAIOptions
): OpenAI {
  if (!config || !config.loop) {
    throw new Error("wrapOpenAI: config.loop is required");
  }

  const wrappedCreate = ((params: WrappedCreateParams, _options?: unknown) => {
    // Separate our field from OpenAI's params before forwarding.
    const { agentloop, ...openaiParams } = params as WrappedCreateParams & {
      agentloop?: PerCallOptions;
    };

    if ("stream" in openaiParams && openaiParams.stream === true) {
      return askWithAgentLoopStream(
        client,
        openaiParams as ChatCompletionCreateParamsStreaming,
        agentloop,
        config
      );
    }

    return askWithAgentLoop(
      client,
      openaiParams as ChatCompletionCreateParamsNonStreaming,
      agentloop,
      config
    );
  }) as typeof client.chat.completions.create;

  // Build a new object that looks like the original client but with our
  // create() swapped in. We intentionally do NOT mutate the original
  // client — callers who want to keep both a wrapped and unwrapped
  // reference can, without the Proxy leaking into other code paths.
  //
  // This is the Langfuse/Helicone convention: wrap returns a distinct
  // object; the original stays pristine.
  //
  // We use a Proxy for the top level so every other property (embeddings,
  // files, audio, etc.) passes through to the original client
  // unchanged, with correct `this` binding.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        // Return a synthetic chat namespace with a swapped-in completions.
        return {
          // Preserve all other methods on `chat` (currently none, but
          // future-proof against OpenAI adding e.g. chat.something).
          ...target.chat,
          completions: {
            ...target.chat.completions,
            create: wrappedCreate,
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
