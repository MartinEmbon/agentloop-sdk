/**
 * Example: wrap an Anthropic client with AgentLoop in 3 lines.
 *
 * Run:
 *   npm install @anthropic-ai/sdk @agentloop-sdk/core @agentloop-sdk/anthropic
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export AGENTLOOP_API_KEY=ak_...
 *   tsx examples/anthropic-wrapped.ts "what's the pix limit at night?"
 */

import Anthropic from "@anthropic-ai/sdk";
import { AgentLoop } from "@agentloop-sdk/core";
import { wrapAnthropic } from "@agentloop-sdk/anthropic";

const loop = new AgentLoop({
  apiKey: process.env.AGENTLOOP_API_KEY ?? (() => { throw new Error("AGENTLOOP_API_KEY is required"); })(),
});

// Wrap once at startup. Every messages.create call on the returned
// client now fires AgentLoop hooks automatically.
const anthropic = wrapAnthropic(new Anthropic(), {
  loop,

  // Optional: detect quality signals from the assistant's response.
  detectSignals: (_question, answer, memories) => {
    const signals: Record<string, boolean> = {};
    if (/i['’]?m not sure|i don['’]?t know|contact support/i.test(answer)) {
      signals.agent_punted = true;
    }
    if (/\$|R\$|%/.test(answer)) signals.factual_claim = true;
    if (signals.factual_claim && memories.length === 0) {
      signals.low_confidence = true;
    }
    return Object.keys(signals).length > 0 ? signals : undefined;
  },
});

export async function ask(question: string, userId: string = "demo_user"): Promise<string> {
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: "You are a helpful customer support assistant. Be concise.",
    messages: [{ role: "user", content: question }],
    agentloop: { userId },
  });

  // Anthropic's content is an array of blocks. Extract text.
  return msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// CLI harness
if (import.meta.url === `file://${process.argv[1]}`) {
  const q = process.argv[2] ?? "What's the Pix limit at night?";
  ask(q)
    .then((a) => console.log("\nAnswer:", a))
    .catch((err) => { console.error(err); process.exit(1); });
}
