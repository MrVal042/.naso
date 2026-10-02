# NASO — Agent Briefing System

NASO (Never Assume, Scan Once) generates a truthful `AGENTS.md` from your repository and keeps it consistent with what actually exists. It runs a one-time `init` → `setup`, copies a small toolset into the repository, installs a minimal pre-commit gate, and gives five tools: `briefing`, `refresh`, `guide`, `validate`, and `doctor`.

The npm package is `naso-dev`, so every command below is `npx naso-dev <command>`.

## Why

An AI coding agent starts every session knowing nothing about your repository. Without a briefing it guesses at architecture and invents files. NASO writes that briefing by reading the repository, with no placeholders and no sections left to "fill later". The pre-commit hook keeps it true by refusing changes that leak secrets or go outside claimed scope, and by appending one line for a genuinely new area.

## Requirements

- Node.js 20 or newer
- Git 2.30 or newer
- A git repository

## Quick Start

Two commands, once per repository:

```bash
npx naso-dev init      # read-only: explains the setup and prints the next command
npx naso-dev setup     # scan, show the plan, accept or reject
```

- **Accept** writes `AGENTS.md`, vendors the toolset into `.naso/tooling/`, installs `.git/hooks/pre-commit`, and — unless you pass `--track` — keeps both `.naso/` and `AGENTS.md` out of git via `.git/info/exclude`.
- **Reject** writes nothing, rescans, and shows the plan again. Rejecting twice offers support or exits and leaves the repository exactly as it was.
- **An existing `AGENTS.md` is never replaced.** The NASO block goes between `<!-- naso:start -->` and `<!-- naso:end -->`; everything outside those markers stays byte-identical.

## What gets installed

| Path                        | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                 | The briefing, inside its `naso:start` / `naso:end` markers. Never overwritten outside them.     |
| `.naso/tooling/*.mjs`       | A copy of the toolset, so the hook works with no network and no global install.                  |
| `.naso/tooling/VERSION`     | The version that copy was vendored from — the briefing stamp is compared against it.             |
| `.naso/config.json`         | Per-repository setup choices, including any areas you excluded.                                  |
| `.git/hooks/pre-commit`     | Runs the secret, scope, format and lint checks on staged files and keeps the briefing current.   |
| `.git/info/exclude`         | Keeps `.naso/` and `AGENTS.md` untracked locally (default mode). Use `--track` to version them.  |

The hook resolves `.naso/tooling/validate.mjs` from `git rev-parse --show-toplevel`, so it runs identically from a clone, from the npx cache, or from a teammate's machine that never installed the package. If the vendored script is ever missing, the hook prints one loud line and lets the commit through rather than failing silently.

## Commands

| Command                                                            | What it does                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `npx naso-dev init [target]`                                        | Read-only orientation. Explains the value, prints the exact next command, writes nothing.                        |
| `npx naso-dev setup [target] [options]`                             | Scan, display the plan, prompt accept/reject (twice max), write on accept. Non-TTY without `--yes` prints and stops. |
| `npx naso-dev briefing [target] [check\|create\|refresh]`           | Verify `AGENTS.md` against disk, write the NASO block, or move the version stamp only.                            |
| `npx naso-dev refresh [target]`                                     | Re-copy the toolset, re-stamp the briefing, reinstall the hook. Never rewrites briefing prose or `.naso/config.json`. |
| `npx naso-dev guide <area-or-prefix> [target]`                      | The guide for one area: its paths, its checks, its boundary rules, and a ready-to-paste `NASO_SCOPE`.            |
| `npx naso-dev guide --list [target]`                                | The areas that exist, with their file counts. Unknown areas are an error, not an empty screen.                   |
| `npx naso-dev guide --tour [target]`                                | The read-through: every section of the briefing in reading order, plus the consistency check.                    |
| `npx naso-dev validate [target] [--staged] [--scope a,b] [--strict]` | The pre-commit gate, and the full CI run without `--staged`.                                                     |
| `npx naso-dev doctor [target]`                                      | Environment and install diagnostics: Node, git, hook, vendored copy, briefing consistency, leftovers.             |

All commands accept `--help`.

## Options

- `--track` — commit `.naso/` and `AGENTS.md` instead of excluding them locally.
- `--no-hook` — do not install the pre-commit hook.
- `--exclude <prefix>` — keep an area out of the briefing. Repeatable. Saved to `.naso/config.json`.
- `--yes` — accept without prompting (CI and scripts).
- `--dry-run` — print the plan and stop. Writes nothing.
- `--force` — on `briefing create`, replace an existing `naso:start` / `naso:end` block. It never touches anything outside the markers.

## Running it without installing

Every command is also a script you can run directly:

```bash
node <path-to-the-naso-dev-package>/bin/naso-dev.mjs setup .
```

The path is wherever the package landed — a clone, `npm i -g`, or the npx cache. `npx naso-dev ...` and `node .../bin/naso-dev.mjs ...` run exactly the same code.

## Support

Email: contactmrval@gmail.com

## License

MIT — see [LICENSE](LICENSE).
