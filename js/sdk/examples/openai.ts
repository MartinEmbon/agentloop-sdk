/**
 * End-to-end example: wrap an OpenAI chat call with AgentLoop.
 *
 * Run with:
 *   npm install openai
 *   export OPENAI_API_KEY=sk-...
 *   export AGENTLOOP_API_KEY=ak_...
 *   tsx examples/openai.ts "what is the pix limit at night?"
 *
 * Mirrors the Python reference implementation in the Luma demo app.
 */

import { AgentLoop } from "../src/index.js";
import OpenAI from "openai";

const loop = new AgentLoop({
  apiKey: process.env.AGENTLOOP_API_KEY ?? (() => { throw new Error("AGENTLOOP_API_KEY is required"); })(),
});

const openai = new OpenAI();

// Percentage of turns logged even if no other signal fires. Gives reviewers
// baseline visibility into what the agent is doing overall, not just
// failures. 15% is a good starting point; tune by org.
const SAMPLE_RATE = 0.15;

const PUNT_PHRASES = [
  "i'm not sure", "i am not sure", "i don't know", "i do not know",
  "contact support", "unable to answer",
];

function detectAgentPunted(response: string): boolean {
  const low = response.toLowerCase();
  return PUNT_PHRASES.some((p) => low.includes(p));
}

function detectFactualClaim(response: string): boolean {
  // "Contains a number + a unit" is a rough proxy for "concrete claim
  // worth auditing." Tune to your domain.
  if (/\$|R\$|%/.test(response)) return true;
  return /\d/.test(response) && /\b(day|hour|week|month|year)\b/i.test(response);
}

export async function ask(
  question: string,
  userId: string = "demo_user",
  sessionId: string = crypto.randomUUID()
): Promise<string> {
  // ---- Step 1: retrieve corrections -----------------------------------
  const memories = await loop.search(question, { user_id: userId, limit: 3 });

  // ---- Step 2: inject corrections into system prompt ------------------
  let system =
    "You are a helpful customer support assistant. " +
    "Be concise — one or two sentences.";
  if (memories.length > 0) {
    system += "\n\nTrusted facts from past corrections:\n";
    for (const m of memories) system += `- ${m.fact}\n`;
  }

  // ---- Step 3: call the LLM -------------------------------------------
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
    temperature: 0.2,
  });
  const answer = resp.choices[0]?.message?.content ?? "";

  // ---- Step 4: signal detection ---------------------------------------
  const signals: Record<string, boolean> = {};
  if (detectAgentPunted(answer)) signals.agent_punted = true;
  if (detectFactualClaim(answer)) signals.factual_claim = true;
  // "Low confidence" proxy: factual claim made without any retrieved
  // memory to back it up. That's a pure guess worth reviewing.
  if (signals.factual_claim && memories.length === 0) signals.low_confidence = true;

  // Random sampling — baseline coverage even when nothing else fires.
  if (Object.keys(signals).length === 0 && Math.random() < SAMPLE_RATE) {
    signals.sample = true;
  }

  // ---- Step 5: log the turn if warranted ------------------------------
  if (Object.keys(signals).length > 0) {
    const { turn_id, was_duplicate } = await loop.logTurn(question, answer, {
      user_id: userId,
      session_id: sessionId,
      signals,
      metadata: { memories_injected: memories.length },
    });
    console.log(`[agentloop] logged turn ${turn_id}${was_duplicate ? " (duplicate)" : ""}`);
  }

  return answer;
}

// Simple CLI harness: node examples/openai.js "your question here"
if (import.meta.url === `file://${process.argv[1]}`) {
  const question = process.argv[2] ?? "What's the Pix limit at night?";
  ask(question)
    .then((answer) => console.log("\nAnswer:", answer))
    .catch((err) => { console.error(err); process.exit(1); });
}
