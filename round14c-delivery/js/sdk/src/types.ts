/**
 * Public type surface for @agentloop-sdk/core.
 *
 * Shapes mirror the backend JSON exactly — snake_case field names preserved.
 * That's a deliberate choice: this is a thin API wrapper, not a UI adapter.
 * TypeScript users get structural types; plain-JS users get the same objects
 * they'd see with a raw fetch call. No surprise renames.
 */

/** Config passed to `new AgentLoop(options)`. */
export interface AgentLoopOptions {
  /**
   * API key starting with `ak_`. Required. Get one from the AgentLoop
   * dashboard → API Keys page.
   */
  apiKey: string;

  /**
   * Base URL of the AgentLoop API. Defaults to the production Cloud
   * Function. Override for local development or a self-hosted deployment.
   */
  baseUrl?: string;

  /**
   * Per-request timeout in milliseconds. Defaults to 10_000 (10 s).
   * AgentLoop calls sit on the critical path of your agent's response, so
   * keep this tight.
   */
  timeoutMs?: number;

  /**
   * HMAC secret for generating signed feedback URLs. Only required if you
   * use `feedbackUrl()`. Must match the backend's `FEEDBACK_SIGNING_SECRET`
   * env var or the backend will reject URLs the SDK signs.
   */
  feedbackSigningSecret?: string;

  /**
   * If true, network/HTTP failures throw `AgentLoopError` instead of
   * returning an empty result. Default false — agent-loop calls are on
   * the critical path and silent degradation is usually the right
   * behavior, but some callers want hard failures for their own retry
   * logic.
   */
  throwOnError?: boolean;

  /**
   * Inject a custom fetch implementation. Useful for testing, or for
   * runtimes where the global `fetch` isn't what you want (custom agents,
   * request signing proxies, etc.). Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch;
}

/** A memory (correction) returned by `search()`. */
export interface Memory {
  id: string;
  fact: string;
  score: number;
  tags: string[];
  source: string;
  created_at: string;
}

/** Options for `search()`. */
export interface SearchOptions {
  /** Scope the search to a specific end-user (e.g. per-tenant overrides). */
  user_id?: string;
  /** Max memories to return. Backend caps at 10. */
  limit?: number;
  /** Only return memories tagged with all of these. */
  tags?: string[];
}

/** Signal flags attached to a turn. Truthy values mark the signal as fired. */
export type TurnSignals = Record<string, boolean | string | number>;

/** Options for `logTurn()`. */
export interface LogTurnOptions {
  user_id?: string;
  session_id?: string;
  signals?: TurnSignals;
  metadata?: Record<string, unknown>;
}

/** Response from `logTurn()`. */
export interface LogTurnResponse {
  turn_id: string;
  status: string; // "pending" | "logged"
  /**
   * Round 9: true if the backend deduplicated this against an existing
   * pending turn (same normalized question, same org). SDK callers can
   * react — e.g. skip any local enrichment they were planning.
   */
  was_duplicate?: boolean;
}

/** Rating of an agent's response. */
export type Rating = "incorrect" | "partial" | "correct";

/** Root cause classification. */
export type RootCause = "context" | "prompt" | "model" | "tool";

/** Options for `annotate()`. */
export interface AnnotateOptions {
  question: string;
  agent_response: string;
  correction: string;
  rating: Rating;
  root_cause?: RootCause;
  tags?: string[];
  reviewer?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

/** Response from `annotate()`. */
export interface AnnotateResponse {
  annotation_id: string;
  memory_id: string;
  status: string; // "active" | "updated_existing"
  duplicate_score?: number;
}

/** Thrown when `throwOnError: true` and a call fails. */
export class AgentLoopError extends Error {
  /** HTTP status code, or 0 for network/timeout errors. */
  public readonly status: number;
  /** Raw response body, if any. */
  public readonly body: string;

  constructor(message: string, status: number = 0, body: string = "") {
    super(message);
    this.name = "AgentLoopError";
    this.status = status;
    this.body = body;
  }
}
