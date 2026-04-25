# r14c-patch1 — CJS build fix + OpenAI v6 peer dep

**Discovered during smoke test of r14c published packages.** Two real bugs in
the CJS (CommonJS) build that I missed in the original tests:

1. **`@agentloop-sdk/core` CJS output was actually ESM** — `tsc` was
   emitting `import`/`export` syntax inside `.cjs` files. Caused
   `require('@agentloop-sdk/core')` to crash with `SyntaxError: Unexpected
   token 'export'`. Affected all three packages (same broken tsconfig).

2. **OpenAI peer dep didn't allow OpenAI v6.** Wrapper said
   `"^4.0.0 || ^5.0.0"`. OpenAI v6 shipped while this round was being
   prepared. Anyone with the latest OpenAI SDK couldn't install the wrapper
   without `--legacy-peer-deps`.

ESM imports (`import { AgentLoop } from "@agentloop-sdk/core"`) worked fine
in r14c — only `require()` was broken. So if your code uses `import`, the
already-published 0.1.1 works. If you (or your customers) ever use
`require()`, you need this patch.

## What's in this patch

| Package | Old version | New version |
|---|---|---|
| `@agentloop-sdk/core` | 0.1.1 (broken CJS) | **0.1.2** |
| `@agentloop-sdk/openai` | 0.1.0 (broken CJS, narrow peer dep) | **0.1.1** |
| `@agentloop-sdk/anthropic` | 0.1.0 (broken CJS) | **0.1.1** |

Python packages: **unchanged**. Python doesn't have the dual ESM/CJS
problem — `pip install agentloop-sdk` was always fine.

## Files changed (3 packages × 3 files)

For each of `js/sdk`, `js/openai`, `js/anthropic`:

- `tsconfig.cjs.json` — explicit `"module": "CommonJS"` instead of
  `"module": "Node16"`. Node16 emits ESM when the parent package.json
  has `"type": "module"`, which we set in r10. CommonJS is unambiguous.
- `scripts/rename-cjs.mjs` — now also writes `dist/cjs/package.json`
  with `{"type":"commonjs"}` as belt-and-suspenders. Even if a future
  tsconfig regression emits ESM by accident, Node will still try to
  parse the files as CJS first and fail loudly.
- `package.json` — version bump.

For `js/openai/package.json` only:
- `peerDependencies.openai` widened from `"^4.0.0 || ^5.0.0"` to
  `"^4.0.0 || ^5.0.0 || ^6.0.0"`.

## Verification

All 36 JS tests still pass after the rebuild (16 + 12 + 8). Real
`require()` smoke test against locally-built packages now works:

```js
const {AgentLoop} = require('@agentloop-sdk/core');
const {wrapOpenAI} = require('@agentloop-sdk/openai');
console.log('OK:', AgentLoop.name, '+', wrapOpenAI.name);
// Prints: OK: AgentLoop + wrapOpenAI
```

## To publish the patch

You're already publishing-ready — same flow as last time, just with the
new files. From the unzipped `round14c-delivery/` folder:

```powershell
cd js\sdk
npm install
npm run build
npm test                              # expect 16 pass
npm publish --access public           # publishes 0.1.2

cd ..\openai
npm install
npm run build
npm test                              # expect 12 pass
npm publish --access public           # publishes 0.1.1

cd ..\anthropic
npm install
npm run build
npm test                              # expect 8 pass
npm publish --access public           # publishes 0.1.1
```

Then verify the fix worked:

```powershell
cd C:\temp
mkdir cjs-fix-smoke
cd cjs-fix-smoke
npm init -y
npm install @agentloop-sdk/core @agentloop-sdk/openai openai
node -e "const {AgentLoop} = require('@agentloop-sdk/core'); const {wrapOpenAI} = require('@agentloop-sdk/openai'); console.log('OK:', AgentLoop.name, '+', wrapOpenAI.name);"
```

Should print `OK: AgentLoop + wrapOpenAI` without needing
`--legacy-peer-deps` (because of the v6 peer dep fix) and without any
SyntaxError (because of the CJS fix).

## What this means for the old versions

- **0.1.1 (core) and 0.1.0 (wrappers) stay published on npm.** You can't
  unpublish those — they're permanent. But `npm install` defaults to
  the highest version, so anyone running `npm install
  @agentloop-sdk/core` from now on gets 0.1.2 automatically.
- I'd also suggest **deprecating the broken versions** so users see a
  warning if they pin to the old version. After publishing 0.1.2:
  ```powershell
  npm deprecate "@agentloop-sdk/core@0.1.1" "Broken CJS build, use 0.1.2+"
  npm deprecate "@agentloop-sdk/openai@0.1.0" "Use 0.1.1+ for OpenAI v6 support and CJS fix"
  npm deprecate "@agentloop-sdk/anthropic@0.1.0" "Broken CJS build, use 0.1.1+"
  ```
  This is purely cosmetic — installs still work — but it's a courtesy
  to anyone who finds the old versions in search.

---

**End of r14c-patch1.**
