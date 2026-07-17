# NASO Scripting Engine Roadmap

This roadmap outlines the implementation phases of the active NASO engine.

See [ADR-0002](decisions/ADR-0002-scripting-scope.md) for why the Rules
Compiler and Context Assembler phases below were rescoped or dropped, and
[docs/prd_specification.md](docs/prd_specification.md) for current specs.

---

## Phase 1: Core Script Framework — done

- [x] Zero-dependency Node ESM scripts in `.naso/scripts/` (`lib.mjs` shared
      helpers: safe command execution, package-manager detection, git status,
      CLI arg parsing).
- [x] All scripts take an optional target-directory argument, defaulting to
      `process.cwd()`, so they run against any repository — not just this one.

## Phase 2: Environment Diagnostic & Validation Gate — done

- [x] `doctor.mjs` — scans stack, package manager, git state, lint/format
      config, NASO integration status.
- [x] `validate.mjs` — split into `--staged` (Prettier + ESLint on staged
      files only, branch-naming check) and full mode (whole-project lint +
      `tsc --noEmit` or the project's own `typecheck` script when one exists
      + test + format).
- [x] Wired `--staged` mode into `bootstrap.mjs`'s `pre-commit` hook
      installer. No third-party git-hook package — the hook is a plain shell
      script written directly to `.git/hooks/pre-commit`.
- [x] Verified end-to-end against a real project (`ecpc-web`): lint and
      typecheck both pass; the fix to prefer the project's own `typecheck`
      script (over a bare `tsc --noEmit`) was found and made from that run —
      `ecpc-web`'s typecheck depends on a `prisma generate` pre-step a bare
      `tsc` call would have skipped.
- [ ] `doctor.mjs` — add framework-level detection (Next.js, React Native,
      etc.) via `package.json` dependencies; add lockfile/`package.json`
      drift detection.

## Phase 3: Bootstrap Linker — done

- [x] `bootstrap.mjs` — writes `.agents/AGENTS.md` in a target repo as a
      pointer to this central `.naso` (relative path under the standard
      sibling-workspace layout, absolute fallback otherwise). Idempotent;
      never overwrites without `--force`.
- [x] Defaults bootstrap artifacts to `.git/info/exclude` instead of a
      tracked `.gitignore` entry, so nothing personal is committed into a
      repository the operator does not own (client/contract work). `--track`
      opts out for repos the operator owns and wants to share the setup in.
- [ ] Extend the linker to place other `bootstrap/<tool>.md` content at the
      paths those tools expect (`.cursorrules`, etc.), on request — no
      Markdown parsing, just placement of already-authored content.

## Phase 4: Guard — done

- [x] `guard.mjs` — warn-only, stack-agnostic checks generalized from
      Patonabl's `tooling/scripts/codebase-guard.mjs`: secret-like paths
      changed, generated/build output staged, dependency files changed.
      Never reads flagged file contents. `--strict` turns warnings into a
      failing exit code when wanted.
- [x] Wired into `bootstrap.mjs`'s pre-commit hook alongside `validate.mjs`,
      informational-only (runs before the blocking checks, never fails the
      commit on its own) — otherwise secret/generated-output warnings only
      surface if the operator remembers to run it manually.

## Phase 5: Multi-Repo Rollout (the actual validation of NASO's premise)

- [x] Ran `doctor.mjs` + `bootstrap.mjs --with-hook` + `guard.mjs` against
      `ecpc-web` — clean working tree preserved (`.agents/` excluded
      locally, not committed), hook installed and verified to actually
      block a non-conventional branch name and allow a conventional one.
- [ ] Run against 2–3 more active repositories (e.g. Taskly, TrustBuild,
      haven-platform).
- [ ] If NASO is not actually bootstrapped into repositories beyond this
      one, the roadmap stops here — an unused tool is not an asset.

## Phase 6: Local Model Assist

Not in the original PRD. `models/registry.yaml` already specified a "fast"
local model tier before any script used it; this phase makes it real.

- [x] `models/registry.yaml` — added a `providers` section (LM Studio,
      `http://localhost:1234/v1`, OpenAI-compatible) and `id` fields so
      scripts know exactly which local model to call.
- [x] `commit-message.mjs` — drafts a commit message from `git diff --cached`
      via the registry's `fast` model. Human reviews and edits; never
      commits on its own. Bounded with a client-side timeout and
      `max_tokens` cap so a stuck local server fails fast instead of
      hanging on Node's ~5-minute default `fetch` timeout.
- [x] Verified live against a running LM Studio instance, and found a real
      issue in the process: the registry's original `fast` pick
      (`qwen/qwen3.5-9b`) is a thinking-mode model that burned its entire
      token budget on hidden reasoning and never produced output, even with
      a `/no_think` hint. Swapped the registry to
      `qwen2.5-coder-7b-instruct` (no reasoning mode) — same request now
      returns a correct commit message in ~1.5s end-to-end.
- [x] Fixed silent diff truncation: dogfooding on `.naso`'s own 30-file
      commit produced a misleadingly generic message because the diff
      exceeded `MAX_DIFF_CHARS` and got sliced mid-file, so the model only
      ever saw the alphabetically-first files. Now falls back to a full
      `git diff --cached --name-status` file list (every file represented,
      not just the first ones to fit) with a system prompt telling the
      model it's summarizing a file list, not a diff, plus stderr warnings
      before and after so the operator knows to double-check the draft.
      Verified against both a normal small diff and a 118KB diff.
- [ ] Consider a changelog/PR-description assist script if commit-message
      proves useful in real day-to-day use — same pattern, same model.
- **Explicitly out of scope**: wiring any local model into `doctor.mjs`,
  `validate.mjs`, or `guard.mjs`. Those stay deterministic — see
  `ai/model-behavior.md`'s "Model Independence" section.

---

## Explicitly dropped (see ADR-0002)

- **Rules Compiler** (`compile-rules.mjs`): parsing Markdown standards into
  per-tool config files. Replaced by the Bootstrap Linker (Phase 3), which
  places hand-authored content instead of generating it from prose.
- **Context Assembler** (`assemble.mjs`): cross-language import resolution
  and diff-shape playbook guessing. No replacement planned; `context.md`'s
  routing model and the agent's own tools already cover this.
- **CI/CD workflow generator**: speculative, unvalidated by any real usage.
  Revisit only if Phase 5 proves the core scripts are actually adopted.
