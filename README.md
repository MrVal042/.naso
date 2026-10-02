# NASO — Agent Briefing System

NASO (Never Assume, Scan Once) generates a truthful `AGENTS.md` from your repository and keeps it consistent with what actually exists. It runs a one-time `init` → `setup`, installs a minimal pre-commit gate, and gives four tools: `briefing`, `guide`, `validate`, and `doctor`.

## Why

An AI coding agent starts every session knowing nothing about your repository. Without a briefing it guesses at architecture and invents files. NASO writes that briefing by reading the repository, with no placeholders and no sections left to "fill later". The pre-commit hook keeps it true by refusing changes that leak secrets, go outside claimed scope, or drift from the briefing.

## Requirements

- Node.js 18.17+ (20+ recommended)
- Git 2.30+
- A git repository

## Quick Start

Two commands, once per repository:

```bash
npx naso init  # read-only: explains the setup and shows the next command
npx naso setup     # scan, show plan, accept or reject; writes AGENTS.md + hook
```

- Accept: writes `AGENTS.md`, installs `.git/hooks/pre-commit`, keeps the file local to this machine by default (`.git/info/exclude`). Pass `--track` to commit it.
- Reject: writes nothing, rescans, shows the plan again. Rejecting twice offers support or exits and leaves the repository unchanged.
- Exit/abort: removes only NASO-owned leftovers and leaves everything else as it was.

## What gets installed

After accept, you get:

- `AGENTS.md` — mechanically derived briefing (no `TODO(fill)` or `TODO(describe)` markers)
- `.git/hooks/pre-commit` — runs secret checks, scope checks, staged format/lint hints, and briefing upkeep
- `.git/info/exclude` — keeps `AGENTS.md` untracked locally (default). Use `--track` to version it.

The tooling itself lives at `/Users/MrVal/WorkSpace/.naso/tooling/` and is shared across all repositories you set up. No `tooling/` directory is copied into each target repo.

## Commands

| Command                                                                       | Purpose                                                                                                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx naso init [target]`                                                      | Read-only orientation. Explains value and prints `npx naso setup [target]`. Never writes.                                                                      |
| `npx naso setup [target] [--track] [--no-hook] [--force] [--yes] [--dry-run]` | Scan, display plan, prompt accept/reject (twice max), write on accept. Non-TTY + no `--yes` prints plan and stops.                                             |
| `npx naso briefing [target] [refresh\|--force]`                               | Regenerate or verify `AGENTS.md` against the current filesystem. Maintains the version stamp. The hook uses this to append lines only for genuinely new areas. |
| `npx naso guide [target] [--short]`                                           | Tour the briefing section-by-section, run the consistency check, list unnamed areas, and suggest next steps.                                                   |
| `npx naso validate [target] [--staged-only] [--strict]`                       | Pre-commit gate: secret blocking, scope enforcement, staged format/lint (non-blocking hints unless `--strict`), briefing upkeep, and branch/append safety.     |
| `npx naso doctor [target]`                                                    | Environment + install diagnostics (Node, git, hook, briefing consistency, leftovers). Read-only.                                                               |

All commands accept `--help`.

## Options

- `--track` — commit `AGENTS.md` (default: keep local only via `.git/info/exclude`)
- `--no-hook` — skip installing the pre-commit hook
- `--force` — overwrite existing `AGENTS.md` (implied when one exists)
- `--yes` — accept without prompting (useful in CI/non-interactive contexts)
- `--dry-run` — print the plan and stop (no writes)
- `--staged-only`/`--strict` — passed through to `validate`

## Notes on the package name

`init` is invoked as `npx naso init` (package `naso`). The remaining commands are `npx naso <cmd>` (binary `naso`). Both resolve from the same installed package in this distribution. If your environment aliases packages differently, you can also run directly with Node: `node /Users/MrVal/WorkSpace/.naso/tooling/<cmd>.mjs`.

## Support

Email: contactmrval@gmail.com

## License

See `LICENSE` if present in the repository root.
