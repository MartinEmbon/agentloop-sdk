/**
 * @agentloop-sdk/core — JavaScript / TypeScript client for the AgentLoop API.
 *
 * Basic usage:
 *
 *   import { AgentLoop } from "@agentloop-sdk/core";
 *
 *   const loop = new AgentLoop({ apiKey: process.env.AGENTLOOP_API_KEY! });
 *
 *   // Before calling your LLM:
 *   const memories = await loop.search("what is the pix limit?");
 *
 *   // After calling your LLM:
 *   await loop.logTurn(question, answer, {
 *     user_id: "user_123",
 *     signals: { thumbs_down: true },
 *   });
 */

export { AgentLoop } from "./agentloop.js";
export { AgentLoopError } from "./types.js";
export type {
  AgentLoopOptions,
  SearchOptions,
  Memory,
  LogTurnOptions,
  LogTurnResponse,
  AnnotateOptions,
  AnnotateResponse,
  Rating,
  RootCause,
  TurnSignals,
} from "./types.js";
