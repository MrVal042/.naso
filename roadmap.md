# NASO Scripting Engine Roadmap

This roadmap outlines the implementation phases of the active NASO engine.

---

## Phase 1: Core Script Framework
- [ ] Create zero-dependency Node ESM template files in `.naso/scripts/`.
- [ ] Implement command runner wrapper (e.g., parsing CLI args).

## Phase 2: Environment Diagnostic & Validation Hook
- [ ] Implement `.naso/scripts/doctor.mjs` (scans active repository state).
- [ ] Implement `.naso/scripts/validate.mjs` (runs lints/tests on git staged files).
- [ ] Wire up git hooks integration using `simple-git-hooks` inside `bootstrap.mjs`.

## Phase 3: Client Config Compiler
- [ ] Implement `.naso/scripts/compile-rules.mjs` (compiles standards into `.cursorrules`, `.agents/AGENTS.md`, and `.aider.conf.yml`).

## Phase 4: Context Compiler (Token Saver)
- [ ] Implement `.naso/scripts/assemble.mjs` (analyses git diff and packages exact files/types for task context).
- [ ] Test context payload output on local repositories.

## Phase 5: CI/CD & Multi-Repo Integrations
- [ ] Implement central CI/CD workflow generator for GitHub Actions.
- [ ] Enable automatic sync of `.naso` upgrades across all workspaces.
