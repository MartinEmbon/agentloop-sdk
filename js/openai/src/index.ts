/**
 * @agentloop-sdk/openai — drop-in wrapper for the OpenAI SDK.
 *
 * Adds AgentLoop pre/post hooks to every chat.completions.create call
 * with two lines of setup:
 *
 *   import OpenAI from "openai";
 *   import { AgentLoop } from "@agentloop-sdk/core";
 *   import { wrapOpenAI } from "@agentloop-sdk/openai";
 *
 *   const openai = wrapOpenAI(new OpenAI(), {
 *     loop: new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! }),
 *   });
 *
 *   // Use exactly like the normal OpenAI SDK. AgentLoop search happens
 *   // before the call; logTurn happens after. Streaming supported.
 *   const resp = await openai.chat.completions.create({
 *     model: "gpt-4o-mini",
 *     messages: [{ role: "user", content: "hello" }],
 *     agentloop: { userId: "u_123" },  // per-call overrides (optional)
 *   });
 */

export { wrapOpenAI } from "./wrap.js";
export { askWithAgentLoop } from "./ask.js";
export { askWithAgentLoopStream } from "./stream.js";
export type { AgentLoopOpenAIOptions, PerCallOptions } from "./ask.js";
export type { WrappedCreateParams } from "./wrap.js";
