/**
 * AgentLoop JavaScript SDK — main client class.
 *
 * Mirrors the shape of the reference Python client documented in the
 * AgentLoop dashboard. Three core methods cover the full integration:
 *
 *   - `search()`       before every LLM call: pull corrections
 *   - `logTurn()`      after every LLM call: queue interesting turns for review
 *   - `annotate()`     when a human reviewer provides a correction directly
 *
 * Plus `feedbackUrl()` for the embedded thumbs-up/down widget.
 *
 * All methods except the explicit `annotate()` write path degrade
 * gracefully on failure: `search()` returns `[]`, `logTurn()` returns `{}`.
 * This is deliberate — AgentLoop calls sit on the critical path of your
 * agent's response. A network blip shouldn't make your chatbot 500.
 * Pass `throwOnError: true` in options to opt into hard failures.
 */

import type {
  AgentLoopOptions,
  SearchOptions,
  Memory,
  LogTurnOptions,
  LogTurnResponse,
  AnnotateOptions,
  AnnotateResponse,
} from "./types.js";
import { AgentLoopError } from "./types.js";
import { hmacSha256Hex } from "./crypto.js";

// Fallback URL used when neither options.baseUrl nor the
// AGENTLOOP_BASE_URL env var is set. Kept here as a constant so future
// backend URL changes (e.g. once we move behind a gateway) land in one
// place.
const FALLBACK_BASE_URL =
  "https://us-central1-easymenu-457215.cloudfunctions.net/agentloop-api";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve the base URL to use for API calls. Priority, highest first:
 *
 *   1. Explicit `options.baseUrl` — caller said exactly this, respect it.
 *   2. `AGENTLOOP_BASE_URL` env var — ops/deployment override without a
 *      code change (useful for local dev, staging, self-hosted
 *      deployments, or pointing at a future gateway).
 *   3. Hardcoded fallback — the current Cloud Function.
 *
 * Environment access is guarded because `process` doesn't exist in
 * Cloudflare Workers, Deno, or browsers — we fall back silently rather
 * than throw.
 */
function resolveBaseUrl(explicit: string | undefined): string {
  if (explicit) return explicit;
  try {
    // `process` may be undefined in non-Node runtimes; guard both the
    // global and the `.env` reference.
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const fromEnv = p?.env?.AGENTLOOP_BASE_URL;
    if (fromEnv) return fromEnv;
  } catch {
    // Ignore — fall through to hardcoded default.
  }
  return FALLBACK_BASE_URL;
}

export class AgentLoop {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly feedbackSigningSecret: string;
  private readonly throwOnError: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentLoopOptions) {
    if (!options || !options.apiKey) {
      throw new AgentLoopError("apiKey is required", 0, "");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = resolveBaseUrl(options.baseUrl).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.feedbackSigningSecret = options.feedbackSigningSecret ?? "";
    this.throwOnError = options.throwOnError ?? false;

    // Resolve fetch. We defer to globalThis.fetch so Cloudflare Workers,
    // Vercel Edge, Node 18+, and browsers all work without a polyfill.
    const resolved = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!resolved) {
      throw new AgentLoopError(
        "No fetch implementation available. Pass options.fetch or run on Node 18+.",
        0,
        ""
      );
    }
    this.fetchImpl = resolved;
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Retrieve corrections relevant to a query. Call this before your LLM
   * call and inject the returned `fact`s into your system prompt.
   *
   * Returns `[]` on any failure (unless `throwOnError: true`).
   */
  async search(query: string, options: SearchOptions = {}): Promise<Memory[]> {
    const body: Record<string, unknown> = {
      query,
      limit: options.limit ?? 3,
    };
    if (options.user_id) body.user_id = options.user_id;
    if (options.tags && options.tags.length > 0) body.tags = options.tags;

    try {
      const data = await this.request<{ memories?: Memory[] }>(
        "POST",
        "/v1/memories/search",
        body
      );
      return data.memories ?? [];
    } catch (err) {
      if (this.throwOnError) throw err;
      return [];
    }
  }

  /**
   * Log an agent turn for later human review. Call this after your LLM
   * responds. Pass signals to tell AgentLoop why this turn is worth
   * looking at (thumbs_down, low_confidence, sample, etc.).
   *
   * Returns `{}` on failure (unless `throwOnError: true`).
   *
   * Round 9 note: the response may include `was_duplicate: true`, meaning
   * the backend deduplicated this turn against an existing pending turn
   * with the same normalized question. The returned `turn_id` points to
   * the merged doc either way.
   */
  async logTurn(
    question: string,
    agentResponse: string,
    options: LogTurnOptions = {}
  ): Promise<LogTurnResponse | Record<string, never>> {
    const body: Record<string, unknown> = {
      question,
      agent_response: agentResponse,
    };
    if (options.user_id) body.user_id = options.user_id;
    if (options.session_id) body.session_id = options.session_id;
    if (options.signals) body.signals = options.signals;
    if (options.metadata) body.metadata = options.metadata;

    try {
      return await this.request<LogTurnResponse>("POST", "/v1/turns", body);
    } catch (err) {
      if (this.throwOnError) throw err;
      return {};
    }
  }

  /**
   * Create an annotation directly (without going through the dashboard
   * review queue). Use this when your application already has a human
   * reviewer providing corrections inline.
   *
   * Always throws on failure — annotate is an explicit write by a human,
   * silently dropping it would hide real bugs from the caller.
   */
  async annotate(options: AnnotateOptions): Promise<AnnotateResponse> {
    if (!options.question || !options.agent_response || !options.correction) {
      throw new AgentLoopError(
        "question, agent_response, and correction are required",
        0,
        ""
      );
    }
    const body: Record<string, unknown> = {
      question: options.question,
      agent_response: options.agent_response,
      correction: options.correction,
      rating: options.rating,
    };
    if (options.root_cause) body.root_cause = options.root_cause;
    if (options.tags) body.tags = options.tags;
    if (options.reviewer) body.reviewer = options.reviewer;
    if (options.user_id) body.user_id = options.user_id;
    if (options.metadata) body.metadata = options.metadata;

    // annotate() always throws — see docstring.
    return this.request<AnnotateResponse>("POST", "/v1/annotations", body);
  }

  /**
   * Generate an HMAC-signed URL for the embedded feedback widget. Drop
   * this into a QR code or an `<a href>` next to the agent's response.
   * The backend validates the signature before recording feedback.
   *
   * Async because Web Crypto's HMAC is async. Requires
   * `feedbackSigningSecret` in the constructor options.
   */
  async feedbackUrl(
    question: string,
    agentResponse: string,
    options: { user_id?: string; session_id?: string } = {}
  ): Promise<string> {
    if (!this.feedbackSigningSecret) {
      throw new AgentLoopError(
        "feedbackSigningSecret is required for feedbackUrl()",
        0,
        ""
      );
    }

    const ts = Math.floor(Date.now() / 1000);
    // Payload is signed with sorted-keys JSON for parity with the Python
    // reference client. Backend verifies the same shape.
    const payload: Record<string, string | number> = {
      q: question,
      a: agentResponse,
      u: options.user_id ?? "",
      s: options.session_id ?? "",
      t: ts,
    };
    const canonical = canonicalJson(payload);
    const sig = await hmacSha256Hex(this.feedbackSigningSecret, canonical);

    const qs = new URLSearchParams();
    qs.set("q", String(payload.q));
    qs.set("a", String(payload.a));
    qs.set("u", String(payload.u));
    qs.set("s", String(payload.s));
    qs.set("t", String(payload.t));
    qs.set("sig", sig);

    return `${this.baseUrl}/feedback?${qs.toString()}`;
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    payload?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    // AbortController gives us real timeouts on all runtimes.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? `Request to ${path} timed out after ${this.timeoutMs}ms`
          : `Network error on ${path}: ${err instanceof Error ? err.message : String(err)}`;
      throw new AgentLoopError(msg, 0, "");
    }
    clearTimeout(timer);

    const bodyText = await res.text();

    if (!res.ok) {
      let message = `Request failed: ${res.status}`;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string };
        if (parsed && typeof parsed.error === "string") message = parsed.error;
      } catch {
        // Non-JSON error body — fall through with the status-code message.
      }
      throw new AgentLoopError(message, res.status, bodyText);
    }

    if (!bodyText) return {} as T;
    try {
      return JSON.parse(bodyText) as T;
    } catch {
      throw new AgentLoopError(
        `Invalid JSON response from ${path}`,
        res.status,
        bodyText
      );
    }
  }
}

/**
 * JSON-stringify with sorted keys. Matches Python's
 * `json.dumps(payload, sort_keys=True)` so the HMAC signatures agree.
 * Only handles the shallow string/number values we use for feedback URLs —
 * not a general deep-sort implementation.
 */
function canonicalJson(obj: Record<string, string | number>): string {
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`);
  return `{${pairs.join(", ")}}`;
}
