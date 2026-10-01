# NASO

> A two-command bootstrap for AI coding agents.
>
> Generate a briefing the agent can trust. Block the commits that leak secrets
> or drift out of scope.

---

## What It Does

Two jobs, and nothing else.

**1. Write the briefing.** `bootstrap.mjs` drops a project-specific `AGENTS.md`
into a repository along with a one-time `SETUP_INSTRUCTIONS.md`. The first agent
that reads the repo fills the briefing in from the real code — not from the
project name — self-checks that every path it claims exists, and asks a human to
confirm before treating it as source of truth.

The point is to stop agents exploring blind, guessing at architecture, and
inventing files that were never there.

**2. Run the mechanical checks.** `guard.mjs` and `validate.mjs` run before each
commit. `guard.mjs` warns about secret-like paths, committed build output, and
dependency changes. `validate.mjs` runs the project's own format and lint on
staged files, checks the branch name, warns when `AGENTS.md` is stale relative to
this tool, and appends a single line when a commit adds a genuinely new area.

No router, no priority hierarchy, no second constitution, no empty directories.

---

## Install

Nothing to install. Clone or copy this directory anywhere and run it with Node
18+.

```bash
node .naso/scripts/bootstrap.mjs ~/code/my-project
```

---

## Usage

### Bootstrap a repository

```bash
node .naso/scripts/bootstrap.mjs <target-dir> [--force] [--no-hook] [--track]
```

Writes into the target:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | The briefing. Version stamp and ownership line at the top. |
| `SETUP_INSTRUCTIONS.md` | One-time guide for the first agent that reads the repo. |
| `.git/hooks/pre-commit` | Runs `guard.mjs --staged` then `validate.mjs --staged`. |

Flags:

- `--force` — overwrite `AGENTS.md` / `SETUP_INSTRUCTIONS.md` if they exist.
- `--no-hook` — skip installing the pre-commit hook. On by default *with* the hook.
- `--track` — commit the briefing files instead of excluding them locally.

By default both briefing files go into `.git/info/exclude`, which is local-only
and never committed. Bootstrapping a client or contract repository therefore
leaves no trace in its history. Pass `--track` for repos you own and want to
share the setup in.

Then: open `SETUP_INSTRUCTIONS.md`, let the first agent fill the briefing in,
confirm it, delete the setup file, commit. After that `AGENTS.md` is maintained
like any other file, through normal code review.

### Validate before a commit

```bash
node .naso/scripts/validate.mjs <target-dir> --staged   # pre-commit gate
node .naso/scripts/validate.mjs <target-dir>            # full lint/typecheck/test/format
node .naso/scripts/validate.mjs <target-dir> --staged --no-append
```

`--staged` is the hook's mode: format and lint on staged files only, branch-name
check, briefing freshness, and the one-line append. `--no-append` suppresses the
append without suppressing the rest.

Full mode is the CI / "am I done" gate.

### Guard

```bash
node .naso/scripts/guard.mjs <target-dir> [--staged] [--strict]
```

Warn-only by default: it prints findings and never blocks. `--strict` exits
non-zero instead. It reads path *shapes* only, never file contents, so a warning
never means a secret was exposed to a log.

---

## The Briefing

`AGENTS.md` describes **what each area does and where it lives**. It is not a
file inventory. Inventories rot the day after they're written; a one-line
description of an area stays true for years.

Generated briefings carry two things at the top:

```markdown
<!-- naso-briefing -->
<!-- version: 2.0.0 -->
<!-- bootstrapped-by: mrval@MacBook-Pro -->
<!-- bootstrapped-at: 2026-10-01 -->
```

`validate.mjs` compares that version against this tool's `VERSION` and prints a
one-line notice when the briefing predates it. The ownership line records who
bootstrapped it and when, and notes that later changes go through normal code
review.

### Keeping It True

The briefing stays accurate because three things protect it:

- **Self-check on first fill.** `SETUP_INSTRUCTIONS.md` requires the agent to
  verify every path it claims actually exists, then get a human to confirm
  before treating the file as truth. Two automated attempts; on a third failure
  it stops and asks the human to write the uncertain sections by hand.
- **A lock.** `.naso.lock` in the target repo is an exclusive-create mutex
  (`wx`, atomic on both POSIX and Windows). Concurrent agents queue behind it or
  skip rather than clobbering each other. A lock older than 15 minutes is treated
  as abandoned and broken, so a crash can't block a repo forever.
- **One line per addition.** When a validated commit adds something genuinely
  new, `validate.mjs` appends a single line inside the `<!-- naso:auto:start -->`
  block under Project Structure. It never regenerates the file and never touches
  prose a human wrote. Past 40 lines in that block, it tells you the briefing has
  started describing files and should be rewritten as prose.

---

## Cross-Platform

Everything is Node.js core modules. No dependencies, no lockfile, no install
step.

The Git hook is the only genuinely platform-sensitive piece. Git for Windows
runs hooks through its bundled POSIX shell, so a `#!/bin/sh` script is correct
on both platforms and no `.cmd` variant is needed. What `bootstrap.mjs` handles
explicitly:

- Hooks directory from `git rev-parse --git-path hooks`, which is correct for
  plain clones, linked worktrees (where `.git` is a *file*), and repos that set
  `core.hooksPath`.
- LF line endings and no BOM — a BOM makes the shebang unrecognizable, CRLF
  breaks the script outright.
- Embedded paths converted to forward slashes and single-quoted, so Windows
  paths with spaces and `C:\` prefixes survive the shell.
- A `node` resolution fallback for hooks, which inherit a minimal `PATH` on some
  systems — if `node` genuinely can't be found the hook exits 0 rather than
  blocking every commit.

---

## Layout

```
.naso/
├── README.md
├── VERSION
├── AGENTS.template.md
├── SETUP_INSTRUCTIONS.md
└── scripts/
    ├── bootstrap.mjs
    ├── guard.mjs
    ├── validate.mjs
    ├── lib.mjs
    └── lock.mjs
```

Six files. Edit `VERSION` to bump the tool; `validate.mjs` will tell every
bootstrapped repo its briefing is behind.
