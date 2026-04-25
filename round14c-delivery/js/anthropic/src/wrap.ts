/**
 * wrapAnthropic — drop-in proxy wrapper for the Anthropic SDK.
 *
 * Mirrors @agentloop-sdk/openai's wrapOpenAI: returns a Proxy that
 * intercepts messages.create calls and routes them through AgentLoop's
 * pre/post hooks. Every other namespace (completions, models, etc.)
 * passes through unchanged.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParams,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { Stream } from "@anthropic-ai/sdk/streaming";

import { askWithAgentLoop } from "./ask.js";
import { askWithAgentLoopStream } from "./stream.js";
import type { AgentLoopAnthropicOptions, PerCallOptions } from "./ask.js";

export type WrappedCreateParams =
  | (MessageCreateParamsNonStreaming & { agentloop?: PerCallOptions })
  | (MessageCreateParamsStreaming & { agentloop?: PerCallOptions });

export function wrapAnthropic(
  client: Anthropic,
  config: AgentLoopAnthropicOptions
): Anthropic {
  if (!config || !config.loop) {
    throw new Error("wrapAnthropic: config.loop is required");
  }

  const wrappedCreate = ((params: WrappedCreateParams, _options?: unknown) => {
    const { agentloop, ...anthropicParams } = params as WrappedCreateParams & {
      agentloop?: PerCallOptions;
    };

    if ("stream" in anthropicParams && anthropicParams.stream === true) {
      return askWithAgentLoopStream(
        client,
        anthropicParams as MessageCreateParamsStreaming,
        agentloop,
        config
      );
    }

    return askWithAgentLoop(
      client,
      anthropicParams as MessageCreateParamsNonStreaming,
      agentloop,
      config
    );
  }) as typeof client.messages.create;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "messages") {
        return {
          ...target.messages,
          create: wrappedCreate,
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
