# NASO Scripting Engine: Product & Functional Requirements Document (PRD/FRD)

> **Revision 2.** Supersedes the original draft. The Rules Compiler and Context
> Assembler as originally specified were rescoped or dropped after comparing
> the plan against Patonabl's existing `tooling/scripts/codebase-*` tools —
> see [ADR-0002](../decisions/ADR-0002-scripting-scope.md) for the reasoning.

## 1. Product Requirements (PRD)

### 1.1 Objective

Transform NASO from a passive set of Markdown guidelines into an active,
zero-dependency automation layer that travels with the operator across every
repository they touch — owned projects and client/contract repositories
alike — instead of being rebuilt from scratch per project.

### 1.2 Target User Personas

1. **The Operator (CTO / Founder / Contractor)**: Works across many
   repositories, not one. Tooling investment in a single flagship project
   (e.g. Patonabl's `codebase:brief`/`:changed`/`:guard`) does not transfer to
   the next repository — a new client engagement, a side project, a repo
   nobody has invested in yet. NASO exists to make the *next* repo cost less
   than the last one, and to double as a demonstrable engineering practice
   asset.
2. **The Developer (Human)**: Needs instant feedback on code compliance and
   minimal friction during setup and commits.
3. **The AI Assistant (Agent)**: Needs clean, concise, relevant context maps
   instead of overwhelming raw repository directories, and needs that context
   available on unfamiliar repositories, not just well-tooled ones.

### 1.3 Key Problems & Solutions

* **Problem**: Tooling investment doesn't transfer between repositories.
  A well-tooled flagship project's context/guard scripts are hardcoded to its
  own structure and provide zero benefit the moment you open a different repo.
  * **Solution**: `doctor.mjs`, `validate.mjs`, and `guard.mjs` are
    stack-agnostic and work on any repository from the first run, with no
    per-project setup. `bootstrap.mjs` wires a repository to the shared
    standards in one command.
* **Problem**: Some repositories are not owned by the operator (client and
  contract work).
  * **Solution**: Bootstrap artifacts default to untracked/local-only
    placement (`.git/info/exclude`, not a committed `.gitignore` entry) so
    nothing personal is ever pushed into a client's history.
* **Problem**: AI context window inflation (token burnout).
  * **Solution**: `context.md`'s routing model (load only what a task
    requires) plus `doctor.mjs`'s compact, structured summary — not a
    generic import-graph analyzer (see 2.2 below for why that was dropped).
* **Problem**: Stale guidelines (Wiki Rot).
  * **Solution**: `doctor.mjs` reports repository reality (stack, configs,
    git state) each run rather than relying on documentation staying
    manually in sync.
* **Problem**: Tooling fragmentation (Cursor vs. Aider vs. Antigravity vs. CI).
  * **Solution**: A bootstrap **linker**, not a rules **compiler** — see 2.1.

---

## 2. Functional Requirements (FRD)

### 2.1 The Bootstrap Linker (`bootstrap.mjs`)

Originally specified as a "Rules Compiler" that would parse Markdown headings
out of `standards/*` and `architecture/*` and generate `.cursorrules`,
`.aider.conf.yml`, etc. **Rejected**: prose is not a grammar, a heading parser
is fragile, and this repository already has hand-authored, human-reviewed
per-tool content in `bootstrap/<tool>.md`. Parsing markdown to regenerate what
a human already wrote correctly is solving an already-solved problem worse.

* **Inputs**: Target repository path; the pre-authored `bootstrap/<tool>.md`
  files in this repository.
* **Outputs**: `.agents/AGENTS.md` in the target repo (a pointer to the
  central `.naso`, not a copy of its content — so it never goes stale as
  NASO evolves). Optionally, a `pre-commit` hook and links/copies of other
  `bootstrap/<tool>.md` files to the paths specific AI tools expect.
* **Functional Logic**:
  - Compute the relative path from the target repo to this `.naso` directory
    (`../.naso` under the standard sibling-workspace layout); fall back to an
    absolute path only when no relative path exists (e.g. different volumes).
  - Never overwrite an existing `.agents/AGENTS.md` without `--force`.
  - Never commit bootstrap artifacts into the target repo's tracked history
    by default — use `.git/info/exclude` unless the operator confirms the
    target repo is their own and opts into tracking it.
  - Optionally install a `pre-commit` hook that calls `validate.mjs --staged`,
    marked with a comment so re-runs are idempotent and hand-written hooks
    are never clobbered.

### 2.2 The Context Assembler — dropped

Originally specified (`assemble.mjs`) to parse imports of modified files
across languages to build a dependency graph, and to guess the relevant
playbook from the shape of a git diff. **Rejected**: a zero-dependency,
multi-language import resolver is a large, ongoing maintenance burden for a
tool whose consumer — an AI coding agent — already has grep/read access and
explores dependency graphs more reliably than a static heuristic can. The
diff-shape playbook heuristic (new file → `new-feature.md`, else →
`bug-fix.md`) is wrong on the first non-trivial diff. `context.md` already
claims "identify task type" as the agent's job in its documented Load Order;
this component would compete with, not extend, that model.

No replacement is planned. If a future need is proven, the minimum viable
version is a diff-name manifest only — no import resolution, no playbook
guessing.

### 2.3 The Validation Gate (`validate.mjs`)

Split into two modes instead of one all-or-nothing run, because a slow
pre-commit hook gets bypassed (`--no-verify`) and defeats its own purpose.

* **`--staged` mode** (the git hook): Prettier + ESLint scoped to
  `git diff --cached --name-only` only; branch-naming convention check.
  Target: **< 2 seconds**, so it never tempts a bypass.
* **default/full mode** (CI or manual "done" gate): whole-project lint,
  `tsc --noEmit` (only if a local `tsc` is installed), test script, format
  check — today's existing behavior, unchanged.
* Architectural-boundary import checks (originally listed under the git
  hook) are **deferred**: `architecture.md` today defines layers as prose
  only, with no machine-readable directory→layer mapping. This check cannot
  be built until that mapping exists as data (a small
  `architecture/boundaries.yaml` or equivalent) — that is an architecture
  task, not a scripting task, and is out of scope until it exists.

### 2.4 The Environment Diagnostician (`doctor.mjs`)

* **Inputs**: Active project directory scan.
* **Outputs**: Clean Markdown summary report to stdout.
* **Functional Logic**:
  - Detect project ecosystem markers (`package.json`, `tsconfig.json`,
    `Gemfile`, `requirements.txt`, `go.mod`, `Cargo.toml`, etc.) and, within
    the Node ecosystem, the specific framework (Next.js, React Native, etc.)
    via `package.json` dependencies.
  - Identify the package manager.
  - Report lockfile/`package.json` **drift** (a dependency missing from the
    lockfile) — not cryptographic "integrity," which is out of scope for a
    diagnostic script.
  - Output summary: active branch, upstream sync state, uncommitted files,
    missing lint/format configs, NASO integration status.

### 2.5 The Guard (`guard.mjs`) — new

Not in the original PRD. Added after reviewing Patonabl's
`tooling/scripts/codebase-guard.mjs`, which validated this pattern in
production: cheap, warn-only, stack-agnostic checks that catch the mistakes
that actually cost a contractor — not style nits.

* **Inputs**: `git status --porcelain` (or `--cached` for the staged variant).
* **Outputs**: Console warnings, grouped by category. Warn-only by default —
  does not block a commit unless `--strict` is passed.
* **Functional Logic**:
  - Flag secret-like paths (`.env`, `*secret*`, `*credential*`, `*token*`,
    `*key*`) changed in the working tree or staged.
  - Flag generated/build-output paths (`dist/`, `build/`, `coverage/`,
    `node_modules/`, etc.) that are staged for commit.
  - Flag dependency/lockfile changes, as a reminder to confirm they're
    intentional.
  - Never read or print the contents of flagged files — path only.

### 2.6 The Commit Message Assistant (`commit-message.mjs`) — new

Not in the original PRD. `models/registry.yaml` already specified a "fast"
local model tier for coding/documentation tasks before this script existed;
this is the first consumer of it. Deliberately scoped to one low-stakes,
human-reviewed generative task rather than a general local-model framework —
see [ADR-0002](../decisions/ADR-0002-scripting-scope.md)'s preference for
narrow, direct implementations over generic ones.

* **Inputs**: `git diff --cached`; the `fast` model + its `provider` entry
  from `models/registry.yaml`.
* **Outputs**: A drafted commit message printed to stdout. Never commits —
  the operator reviews and edits before using it.
* **Functional Logic**:
  - Read the local provider's `base_url` and model `id` from
    `models/registry.yaml` (a small parser scoped to that file's own flat
    shape — not a general YAML parser).
  - POST to the provider's OpenAI-compatible `/chat/completions` endpoint
    using Node's built-in `fetch`. No SDK, no dependency.
  - Bound every request: a client-side timeout (default 60s) and a
    `max_tokens` cap, so a stuck or slow local server fails fast and
    clearly instead of hanging on Node's internal ~5-minute default.
  - Fail clearly, not silently, when the local server is unreachable, the
    model returns no content, or truncates before producing real output
    (verified in production: a thinking-mode model can burn its entire
    token budget on hidden reasoning and return nothing usable — the error
    message must say so, not just "no content").
* **Explicitly out of scope**: this script must never be wired into
  `doctor.mjs`, `validate.mjs`, or `guard.mjs`. Those stay deterministic —
  `ai/model-behavior.md`'s "Model Independence" section requires engineering
  standards to never depend on which model or how capable it is; a gate
  whose pass/fail depends on a local model's output would violate that.

---

## 3. Boundary & Non-Functional Requirements

* **Zero Dependencies**: Must run on pure Node.js ESM, core modules only. No
  third-party packages — this includes git-hook installer packages
  (e.g. `simple-git-hooks`); hooks are written directly by `bootstrap.mjs`.
* **Execution Speed**: The staged/pre-commit validation path must execute in
  `< 2.0 seconds`. The full validation path (lint + typecheck + test) has no
  such constraint and is expected to take longer.
* **Idempotency**: Bootstrapping, hook installation, and repeated runs of any
  script must not duplicate output or crash on re-run.
* **Repository Safety**: No script may write tracked, committable files into
  a repository the operator does not own without explicit opt-in. Default to
  local-only placement (`.git/info/exclude`) for any generated artifact in a
  target repository.
