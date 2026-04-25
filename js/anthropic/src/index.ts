/**
 * @agentloop-sdk/anthropic — drop-in wrapper for the Anthropic SDK.
 *
 * Adds AgentLoop pre/post hooks to every messages.create call with
 * two lines of setup:
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { AgentLoop } from "@agentloop-sdk/core";
 *   import { wrapAnthropic } from "@agentloop-sdk/anthropic";
 *
 *   const anthropic = wrapAnthropic(new Anthropic(), {
 *     loop: new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! }),
 *   });
 *
 *   const msg = await anthropic.messages.create({
 *     model: "claude-opus-4-7",
 *     max_tokens: 1024,
 *     messages: [{ role: "user", content: "hello" }],
 *     agentloop: { userId: "u_123" },
 *   });
 */

export { wrapAnthropic } from "./wrap.js";
export { askWithAgentLoop } from "./ask.js";
export { askWithAgentLoopStream } from "./stream.js";
export type { AgentLoopAnthropicOptions, PerCallOptions } from "./ask.js";
export type { WrappedCreateParams } from "./wrap.js";
