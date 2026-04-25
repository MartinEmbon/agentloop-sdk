# Round 14c — Monorepo + publishing-ready

**Goal**: take the six packages from rounds 10–13 and assemble them into
a single GitHub-ready monorepo, then publish all six to npm and PyPI.

This round is mostly **operational** — no new features, just renames,
URL fixes, repo organization, and registry publishing.

---

## What changed

### Renames

**Python core package:** `agentloop` → `agentloop-py` on PyPI

The PyPI name `agentloop` is taken by an unrelated 2021 package (a
small "agent loop control" library, very few downloads). Rather than
attempt a transfer or pick a different name, we renamed the install
target to `agentloop-py`. The Python module name stays `agentloop`,
matching the JS SDK convention.

```diff
- pip install agentloop
+ pip install agentloop-py

  from agentloop import AgentLoop    # unchanged
```

This is the same pattern as `pip install beautifulsoup4` → `from bs4
import ...`. PyPI install names and Python module names don't have to
match, and many established packages use this convention.

### Version bumps

| Package | Version before | Version after |
|---|---|---|
| `@agentloop-py/core` | 0.1.1 | 0.1.1 (no change) |
| `@agentloop-py/openai` | 0.1.0 | 0.1.0 (no change) |
| `@agentloop-py/anthropic` | 0.1.0 | 0.1.0 (no change) |
| `agentloop-py` (Python core) | 0.1.1 (was `agentloop`) | **0.1.2** |
| `agentloop-py-openai` (Python) | 0.1.0 | **0.1.1** |
| `agentloop-py-anthropic` (Python) | 0.1.0 | **0.1.1** |

JS packages unchanged. Only the three Python packages bumped — core
got `0.1.2` to mark the rename, and the two wrappers got `0.1.1`
because their `dependencies` array now references `agentloop-py>=0.1.2`
instead of the old `agentloop>=0.1.0`.

### Repository URLs

All six packages now point at `https://github.com/martinembon/agentloop-py`
(replacing placeholder URLs like `github.com/agentloop/sdk-py` and
`agentloop.dev`). When customers click through from npm or PyPI to
the source, they land in the right place.

### Monorepo structure

```
round14c-delivery/                   ← the deliverable
├── README.md                        ← top-level: what AgentLoop is
├── LICENSE                          ← MIT
├── .gitignore                       ← node, python, IDE, OS junk
├── CHANGES.md                       ← this file
├── js/
│   ├── sdk/                         → @agentloop-py/core
│   ├── openai/                      → @agentloop-py/openai
│   └── anthropic/                   → @agentloop-py/anthropic
└── py/
    ├── sdk/                         → agentloop-py
    ├── openai/                      → agentloop-py-openai
    └── anthropic/                   → agentloop-py-anthropic
```

One repo, six packages. Convention used by Vercel SDK, Anthropic's
own SDKs, OpenAI's SDKs, LangChain — issues, PRs, and CI all live in
one place.

### Test sweep

All 84 tests still pass after renames + URL updates:

| Package | Tests |
|---|---|
| `@agentloop-py/core` | 16 |
| `@agentloop-py/openai` | 12 |
| `@agentloop-py/anthropic` | 8 |
| `agentloop-py` | 27 |
| `agentloop-py-openai` | 12 |
| `agentloop-py-anthropic` | 9 |
| **Total** | **84** |

---

## Publishing playbook

This is the operational part. Three phases: GitHub, npm, PyPI.
**Do them in this order.** Each step takes ~5 minutes.

### Phase 1 — GitHub (~10 minutes)

1. Sign in to https://github.com as `martinembon`.
2. Click "New repository" (top-right `+` menu).
3. Settings:
   - **Owner**: `martinembon`
   - **Repository name**: `agentloop-py`
   - **Public** (must be public for npm/PyPI users to read source)
   - **Do NOT initialize with README, .gitignore, or LICENSE** — we have them already
4. Click "Create repository". You'll see an empty repo with setup instructions.

5. From PowerShell, in the unzipped delivery folder:

   ```powershell
   cd C:\path\to\round14c-delivery
   git init
   git add .
   git commit -m "Initial commit — six SDK packages"
   git branch -M main
   git remote add origin https://github.com/martinembon/agentloop-py.git
   git push -u origin main
   ```

   You may be prompted to authenticate. GitHub no longer accepts
   passwords on git push — use a personal access token (Settings →
   Developer settings → Personal access tokens → Tokens (classic) →
   Generate new token, with `repo` scope), or set up GitHub CLI (`gh
   auth login`).

6. Verify in your browser: https://github.com/martinembon/agentloop-py
   should now show all the files. Check that the README renders nicely
   on the homepage.

### Phase 2 — npm (~15 minutes)

**Pre-flight:**

1. Sign up / sign in at https://www.npmjs.com.
2. Go to Account Settings → Two-Factor Authentication.
   **Enable 2FA**. npm requires 2FA for publishing as of 2024.
3. From PowerShell, run `npm login`. Enter username, password, and OTP.
4. Verify with `npm whoami` — should print your username.

**Publishing the JS packages — order matters:**

The wrappers (`@agentloop-py/openai`, `@agentloop-py/anthropic`) declare
`@agentloop-py/core` as a peer dependency. They'll work even if the SDK
isn't on npm yet (peer deps are resolved at install time, not publish
time), but it's cleaner to publish core first.

```powershell
# 1. Build and publish core
cd C:\path\to\round14c-delivery\js\sdk
npm install
npm run build
npm test                              # 16 pass
npm publish --access public           # --access public is REQUIRED for scoped packages
```

> **Critical**: `--access public`. Without this flag, npm tries to publish
> scoped packages (`@agentloop-py/...`) as private, which requires a paid
> npm account. With it, anyone can install for free.

```powershell
# 2. OpenAI wrapper
cd ..\openai
npm install
npm run build
npm test                              # 12 pass
npm publish --access public

# 3. Anthropic wrapper
cd ..\anthropic
npm install
npm run build
npm test                              # 8 pass
npm publish --access public
```

After each `npm publish`, you should see output like:
```
+ @agentloop-py/core@0.1.1
```

Then visit:
- https://www.npmjs.com/package/@agentloop-py/core
- https://www.npmjs.com/package/@agentloop-py/openai
- https://www.npmjs.com/package/@agentloop-py/anthropic

Each should now show your package, the README, and the install command.

**Smoke test the published packages:**

```powershell
cd C:\temp
mkdir npm-smoke-test
cd npm-smoke-test
npm init -y
npm install @agentloop-py/core @agentloop-py/openai openai
node -e "const { AgentLoop } = require('@agentloop-py/core'); console.log('imported:', AgentLoop.name);"
# Should print: imported: AgentLoop
```

### Phase 3 — PyPI (~15 minutes)

**Pre-flight:**

1. Sign up / sign in at https://pypi.org/account/register/.
2. Go to Account Settings → Two factor authentication.
   **Enable 2FA**. PyPI requires 2FA for publishing as of 2024.
3. Generate an API token at Account Settings → API tokens → Add API
   token. Scope: "Entire account" for the first publish (you can
   restrict per-project later). Save the token starting with `pypi-`.
4. Configure twine to use the token. Create or edit
   `%USERPROFILE%\.pypirc`:

   ```ini
   [pypi]
     username = __token__
     password = pypi-AgEIcHlwaS5vcmc...   ; your full token
   ```

   The literal username `__token__` (with double underscores) tells
   PyPI to authenticate via API token rather than password.

**Publishing the Python packages — same order:**

```powershell
# 1. Build and publish core
cd C:\path\to\round14c-delivery\py\sdk
pip install --upgrade build twine
python -m build                            # produces dist/*.whl + dist/*.tar.gz
python -m twine upload dist/*
```

You'll see output:
```
Uploading agentloop_sdk-0.1.2-py3-none-any.whl
100% ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 12.3/12.3 kB
View at: https://pypi.org/project/agentloop-py/0.1.2/
```

```powershell
# 2. OpenAI wrapper
cd ..\openai
python -m build
python -m twine upload dist/*

# 3. Anthropic wrapper
cd ..\anthropic
python -m build
python -m twine upload dist/*
```

Then visit:
- https://pypi.org/project/agentloop-py/
- https://pypi.org/project/agentloop-py-openai/
- https://pypi.org/project/agentloop-py-anthropic/

**Smoke test the published packages:**

```powershell
cd C:\temp
mkdir pypi-smoke-test
cd pypi-smoke-test
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install agentloop-py agentloop-py-openai openai
python -c "from agentloop import AgentLoop; print('imported:', AgentLoop.__name__)"
# Should print: imported: AgentLoop
```

---

## Gotchas

### Order matters

Always publish **core first**, then wrappers:
- npm: `@agentloop-py/core` → `@agentloop-py/openai` → `@agentloop-py/anthropic`
- PyPI: `agentloop-py` → `agentloop-py-openai` → `agentloop-py-anthropic`

Wrappers list core as a dependency. If you publish a wrapper first, the
metadata is valid but anyone trying to install gets a "core not found"
error until you publish core too.

### Versions are immutable

Once you publish `@agentloop-py/core@0.1.1` to npm or `agentloop-py==0.1.2`
to PyPI, you cannot edit or republish that exact version. To fix
something, bump to `0.1.3` and republish.

You CAN unpublish on npm within 72 hours of publishing (and only if
fewer than ~300 downloads). PyPI is stricter — once published, versions
are essentially permanent. **Verify everything before each publish.**

### The `--access public` flag

If you forget `--access public` on the first npm publish, npm rejects
with a "you need a paid plan to publish private packages" error. Just
re-run with the flag.

### `pyproject.toml` validation

Before each `python -m build`, verify the package builds without errors:
```powershell
python -m build --sdist --wheel
```
If it fails, the error message is usually a missing field in
`pyproject.toml` or a malformed dependency string. Fix and retry.

### 2FA prompts during publish

Both npm and PyPI will prompt for a 2FA code on each publish. Have
your authenticator app open before running `npm publish` or `twine
upload`. The prompts time out after ~30 seconds.

### After-publish: verify install paths in fresh environments

We already smoke-tested locally, but it's worth a final verify in a
truly fresh environment (a fresh `npm init` folder, a fresh Python
venv) to confirm the published packages install cleanly. Five minutes,
catches dependency-resolution issues that local installs wouldn't.

---

## What's NOT in this round

- **No code changes.** Just renames, URL updates, and packaging.
- **No new features.** All behavior identical to round 13.
- **No domain.** You decided to skip purchasing a domain in trying
  phase. The `homepage` field in package metadata points to GitHub.
- **No security upgrades.** Request signing, PII scrubbing, retry-with-
  backoff still backlog.
- **No changelogs per package.** Each package's history can be
  reconstructed from git tags after the first publish.

---

## Summary of operational checklist

Cross off as you go.

- [ ] Phase 1 — GitHub
  - [ ] Create `martinembon/agentloop-py` repo (public, no init files)
  - [ ] `git init / add / commit / push` from delivery folder
  - [ ] Verify README renders on github.com homepage
- [ ] Phase 2 — npm
  - [ ] `npm login` with 2FA enabled
  - [ ] Publish `@agentloop-py/core` (`--access public`)
  - [ ] Publish `@agentloop-py/openai`
  - [ ] Publish `@agentloop-py/anthropic`
  - [ ] Smoke test fresh install
- [ ] Phase 3 — PyPI
  - [ ] PyPI account with 2FA + API token configured in `.pypirc`
  - [ ] `python -m build && twine upload` for `agentloop-py`
  - [ ] Same for `agentloop-py-openai`
  - [ ] Same for `agentloop-py-anthropic`
  - [ ] Smoke test fresh venv install

When all 12 boxes are ticked, the SDKs are live and anyone in the
world can install them.

---

**End of Round 14c.**
