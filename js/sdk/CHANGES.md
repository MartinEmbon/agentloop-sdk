# Round 10 — JavaScript SDK (`@agentloop-sdk/core`)

**Goal**: ship a first-class JavaScript/TypeScript SDK that mirrors the
inline Python `AgentLoop` class from the Luma demo. Zero dependencies,
works everywhere, ready to publish to npm.

---

## What shipped

A complete, buildable npm package at `agentloop-sdk-js/`:

```
agentloop-sdk-js/
├── package.json              — dual CJS/ESM exports, Node 18+
├── tsconfig.json             — strict base config
├── tsconfig.esm.json         — ESM build
├── tsconfig.cjs.json         — CJS build
├── tsconfig.types.json       — declaration-only build
├── src/
│   ├── index.ts              — public entry point
│   ├── agentloop.ts          — main class (search/logTurn/annotate/feedbackUrl)
│   ├── types.ts              — public type surface + AgentLoopError
│   └── crypto.ts             — Web Crypto HMAC helper
├── scripts/
│   ├── rename-cjs.mjs        — post-build: .js → .cjs for CJS output
│   └── dual-types.mjs        — post-build: duplicate .d.ts → .d.cts
├── test/
│   └── agentloop.test.mjs    — 14 tests, built-in node:test runner
├── examples/
│   └── openai.ts             — full pre/post-LLM integration pattern
├── README.md                 — install, quick start, OpenAI + Anthropic examples
└── LICENSE                   — MIT
```

---

## Design decisions

### TypeScript-first, ship both CJS + ESM
The `.ts` source compiles to three outputs:
- `dist/esm/*.js` — ESM, consumed via `import`
- `dist/cjs/*.cjs` — CJS, consumed via `require` (renamed from `.js` so
  Node doesn't try to load them as ESM under `"type": "module"`)
- `dist/types/*.d.ts` + `*.d.cts` — type declarations for both formats

Modern `exports` map in `package.json` routes resolvers correctly:

```json
"exports": {
  ".": {
    "import": { "types": "./dist/types/index.d.ts", "default": "./dist/esm/index.js" },
    "require": { "types": "./dist/types/index.d.cts", "default": "./dist/cjs/index.cjs" }
  }
}
```

### Zero runtime dependencies
Uses native `fetch` (Node 18+, all browsers, all Edge runtimes) and Web
Crypto (same coverage). No `axios`, no `node-fetch` shim, no `node:crypto`
import. The SDK works identically on Node, Cloudflare Workers, Vercel
Edge, and Deno.

### Graceful-degrade by default, opt into hard failures
`search()` returns `[]` and `logTurn()` returns `{}` on any error — a
network blip on AgentLoop shouldn't bring down the caller's agent.
`annotate()` always throws because it represents explicit reviewer work
that should never be silently lost. `throwOnError: true` on construction
flips the first two to throw on failure.

### Single class, mirrors Python exactly
`AgentLoop` is the only class. Methods: `search`, `logTurn`, `annotate`,
`feedbackUrl`. Same names as the Python reference in the Luma demo, same
argument shapes, same response shapes (snake_case preserved — this is a
thin API wrapper, not a UI adapter).

Deliberately **not** including framework wrappers (`withOpenAI`,
`withAnthropic`, LangChain middleware). Those belong in separate
packages so the core SDK isn't on the hook for framework churn. That's
Round 11.

### HMAC compatibility verified byte-for-byte
The `feedbackUrl()` method produces HMAC-SHA256 signatures that match
the Python reference implementation exactly. Confirmed with a test that
compares against a known Python output:

```
Input:  payload = {'q': 'hi', 'a': 'hello', 'u': 'u1', 's': 's1', 't': 1234}
        secret  = 'secret'
Python: hmac.new(b'secret', json.dumps(payload, sort_keys=True).encode(), sha256).hexdigest()
        → 1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a
JS:     await loop.feedbackUrl('hi', 'hello', {user_id: 'u1', session_id: 's1'})
        URL contains: sig=1642f0aa8a1266ff3edb137add421b28185a5e88bd105c368c5efcdd35e53b7a
```

Test `feedbackUrl() produces HMAC signature matching Python reference`
is green. Feedback URLs signed by the JS SDK validate against the same
backend that Luma (Python) signs for.

One small API divergence from Python: `feedbackUrl()` is `async`
because Web Crypto's HMAC is always async. Python's `hashlib` is sync.
Documented in the method's JSDoc.

### Real timeouts
`AbortController` gives actual request timeouts on every runtime.
Default 10 seconds, configurable per-instance via `timeoutMs`.

### `Round 9` awareness
`LogTurnResponse.was_duplicate` is typed and documented. Callers can
react when the backend deduplicated their turn against an existing
pending one.

---

## Test results

```
$ node --test test/*.test.mjs
...
# tests 14
# suites 0
# pass 14
# fail 0
```

All 14 tests pass, including:
- `search()` request shape, auth header, graceful degrade
- `logTurn()` including Round 9 `was_duplicate` response
- `annotate()` validation and always-throws behavior
- `feedbackUrl()` HMAC byte-match vs Python reference
- `AgentLoopError` status/body propagation

Tests use Node 18+'s built-in test runner (`node:test` + `node:assert`).
No Jest, no Mocha, no test-framework dependencies. Run with `npm test`.

---

## Build output verified

```
$ npm run build
...
dist/cjs/agentloop.cjs
dist/cjs/crypto.cjs
dist/cjs/index.cjs
dist/cjs/types.cjs
dist/esm/agentloop.js
dist/esm/crypto.js
dist/esm/index.js
dist/esm/types.js
dist/types/*.d.ts  (4 files)
dist/types/*.d.cts (4 files)
```

16 files emitted. `npm run typecheck` clean. `npm test` green.

---

## Publishing steps (when ready)

1. **Reserve the scope on npm** (first-time only):
   ```bash
   npm login
   npm org create agentloop   # or use existing org
   ```

2. **Review `package.json`**. `version: 0.1.0` is a reasonable starting
   version for "SDK exists, works, no customers on it yet." Change
   `repository.url` if the actual GitHub URL is different.

3. **Build + test + publish**:
   ```bash
   cd agentloop-sdk-js
   npm install
   npm run build
   npm test
   npm publish --access public
   ```

   `--access public` is required for scoped packages on a free npm
   account. Drop it if you're on a paid org and prefer private-by-default.

4. **Verify the install**:
   ```bash
   mkdir /tmp/sdk-test && cd /tmp/sdk-test
   npm init -y
   npm install @agentloop-sdk/core
   node -e "const { AgentLoop } = require('@agentloop-sdk/core'); console.log(AgentLoop)"
   ```

---

## What's NOT in this round

- **No framework wrappers.** LangChain, LlamaIndex, Vercel AI SDK glue
  is Round 11. Intentional — keeps the core SDK thin and framework-churn-proof.
- **No Python SDK repackaging.** The inline `AgentLoop` class in
  `luma-demo/backend/main.py` still exists as-is. Formalizing it as a
  standalone `agentloop` pip package is worth doing but it's a separate
  round; the JS SDK doesn't block on it.
- **No browser example.** The SDK works in browsers, but exposing an
  `ak_` key from the browser is a security mistake — you'd want the key
  on a proxy server. Leaving the browser story for a future round that
  introduces session-scoped keys or signed feedback URLs (which are
  already safe for browsers).
- **No retry/backoff logic.** Single attempt per call, graceful degrade
  on failure. If a customer needs retries they can wrap `search()`
  themselves. Adding built-in retries without careful thought (jitter,
  budget, deduplication) would be worse than none at all.

---

## Caveats

- **Package version is 0.1.0.** First publish. Expect a 0.2.0 when the
  framework adapters ship in Round 11 and we confirm the core surface
  didn't need to change to support them.
- **`@agentloop-sdk/core` name is not yet reserved on npm.** Check
  availability before running `npm publish`. If taken, fallback options:
  `agentloop`, `@agentloop-sdk/core`, etc.
- **Repository URL in `package.json` is a placeholder.** Update to the
  real GitHub URL before publishing.
- **Node 18+ required.** Older Node lacks native `fetch`. If supporting
  Node 16 becomes necessary, add `undici` as an optional peer dep —
  small code change, easy to backport.
- **No CI pipeline included.** GitHub Actions `.yml` for
  build-and-test-on-PR is worth adding when the repo goes public; out
  of scope for this round.

---

## Windows portability fixes (post-initial-delivery)

Three small cross-platform bugs surfaced during local smoke-testing on
Windows/PowerShell and were fixed in-place before anything shipped to
npm:

1. **`package.json` `clean` script** — `rm -rf dist` is Unix-only.
   Replaced with `node -e "require('fs').rmSync('dist',{recursive:true,force:true})"`
   which works identically on Windows, macOS, and Linux with no extra
   dependencies.

2. **`scripts/rename-cjs.mjs` — `.pathname` on Windows** — using
   `new URL(...).pathname` against a `file://` URL returns `/C:/Users/...`
   on Windows, which becomes `C:\C:\Users\...` (doubled drive letter) when
   Node resolves it. Switched to `fileURLToPath(new URL(...))` which
   handles the platform difference correctly.

3. **`scripts/dual-types.mjs`** — same `.pathname` → `fileURLToPath`
   fix. Same root cause.

Lesson: the handoff explicitly notes the user is on Windows/PowerShell.
Future rounds involving shell scripts or filesystem URLs need to be
tested against Windows conventions, not assumed-Unix.

---

**End of Round 10.**
