/**
 * Example: wrap an OpenAI client with AgentLoop in 3 lines.
 *
 * Run:
 *   npm install openai @agentloop-sdk/core @agentloop-sdk/openai
 *   export OPENAI_API_KEY=sk-...
 *   export AGENTLOOP_API_KEY=ak_...
 *   tsx examples/openai-wrapped.ts "what's the pix limit at night?"
 */

import OpenAI from "openai";
import { AgentLoop } from "@agentloop-sdk/core";
import { wrapOpenAI } from "@agentloop-sdk/openai";

const loop = new AgentLoop({
  apiKey: process.env.AGENTLOOP_API_KEY ?? (() => { throw new Error("AGENTLOOP_API_KEY is required"); })(),
});

// Wrap once at startup. Every chat.completions.create call on the
// returned client now fires AgentLoop hooks automatically.
const openai = wrapOpenAI(new OpenAI(), {
  loop,

  // Optional: detect quality signals from the assistant's response.
  // Fires before logTurn; signals appear in the Review queue.
  detectSignals: (_question, answer, memories) => {
    const signals: Record<string, boolean> = {};
    if (/i['’]?m not sure|i don['’]?t know|contact support/i.test(answer)) {
      signals.agent_punted = true;
    }
    if (/\$|R\$|%/.test(answer)) signals.factual_claim = true;
    // Low confidence: made a factual claim without any memory backing it.
    if (signals.factual_claim && memories.length === 0) {
      signals.low_confidence = true;
    }
    return Object.keys(signals).length > 0 ? signals : undefined;
  },
});

export async function ask(question: string, userId: string = "demo_user"): Promise<string> {
  // Looks like a normal OpenAI call. AgentLoop hooks fire invisibly.
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a helpful customer support assistant. Be concise." },
      { role: "user", content: question },
    ],
    temperature: 0.2,
    agentloop: { userId },
  });

  return resp.choices[0]?.message?.content ?? "";
}

// CLI harness
if (import.meta.url === `file://${process.argv[1]}`) {
  const q = process.argv[2] ?? "What's the Pix limit at night?";
  ask(q)
    .then((a) => console.log("\nAnswer:", a))
    .catch((err) => { console.error(err); process.exit(1); });
}
