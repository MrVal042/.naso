# NASO

> A two-command bootstrap for AI coding agents.
>
> Generate a briefing the agent can trust. Stop the commits that would leak a
> secret, and — when you name a scope — the ones that wander outside it.

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
commit. In `--staged` mode `guard.mjs` refuses the commit on high-confidence
secrets — an `.env`, a `.pem`, a private key header — and warns about softer
signals like committed build output and dependency changes. `validate.mjs` runs
the project's own format and lint on staged files, warns on an off-convention
branch name, warns when `AGENTS.md` is stale relative to this tool, and appends
a single line when a commit adds a genuinely new area.

`check-briefing.mjs` closes the loop: it reads only `AGENTS.md` and reports paths
the briefing claims that don't exist, real top-level areas it never mentions, and
markers still left unfilled.

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
node .naso/scripts/bootstrap.mjs <target-dir> [--force] [--refresh] [--no-hook] [--track]
```

Writes into the target:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | The briefing. Version stamp and ownership line at the top. |
| `SETUP_INSTRUCTIONS.md` | One-time guide for the first agent that reads the repo. |
| `.git/hooks/pre-commit` | Runs `guard.mjs --staged` then `validate.mjs --staged`. |

Flags:

- `--force` — overwrite `AGENTS.md` / `SETUP_INSTRUCTIONS.md` if they exist.
- `--refresh` — re-stamp an existing briefing against this tool's `VERSION` and
  reinstall the hook, **without** rewriting the briefing or the setup file. Use
  this when `validate.mjs` reports your briefing is behind.
- `--no-hook` — skip installing the pre-commit hook.
- `--track` — commit the briefing files instead of excluding them locally.

**Two modes, and they mean different things.** By default both briefing files go
into `.git/info/exclude`, which is local-only and never committed: bootstrapping
a client or contract repository leaves no trace in its history, and no teammate
gets a half-filled briefing pushed at them. Pass `--track` for repos you own and
want to share the setup in, where the briefing is reviewed like any other file.

Then: open `SETUP_INSTRUCTIONS.md`, let the first agent fill the briefing in,
confirm it, and follow step 5 there — it branches on which mode you're in. After
that `AGENTS.md` is maintained through normal code review.

### Validate before a commit

```bash
node .naso/scripts/validate.mjs <target-dir> --staged   # pre-commit gate
node .naso/scripts/validate.mjs <target-dir>            # full lint/typecheck/test/format
node .naso/scripts/validate.mjs <target-dir> --staged --no-append
```

`--staged` is the hook's mode: format and lint on staged files only, branch-name
check, briefing freshness, and the one-line append. `--no-append` suppresses the
append without suppressing the rest. Full mode is the CI / "am I done" gate.

**Branch names warn, they don't block.** An unconventional name is worth knowing
about; refusing a commit because of it produces `--no-verify` habits faster than
anything else in this tool.

**The append stages `AGENTS.md` only when it is tracked and clean.** If a human
has the file open with unstaged edits, NASO appends its line and leaves staging
alone rather than sweeping their work into your commit. If the briefing is
locally excluded (the default), there is nothing to stage.

### Check the briefing on its own

```bash
node .naso/scripts/check-briefing.mjs <target-dir>
```

Exits non-zero and reports three kinds of problem:

- **MISSING** — a path the briefing claims that does not exist on disk.
- **UNCOVERED** — a real top-level area the briefing never mentions.
- **UNFILLED** — a `TODO(fill)` or `TODO(describe)` marker still in the file.

This is the check `SETUP_INSTRUCTIONS.md` step 3 tells the first agent to run
until it comes back clean. It reads `AGENTS.md` and directory entries, and the
contents of no other file.

### Guard

```bash
node .naso/scripts/guard.mjs <target-dir> [--staged] [--strict]
                                  [--scope <prefix,prefix,...>]
```

**High-confidence secrets block the commit** in `--staged` mode, which is the
hook's mode: `.env` and `.env.*` (minus `.env.example` and friends), `.pem` /
`.p12` / `.pfx` / `.key`, `id_rsa*` / `id_ed25519*`, and a small set of content
shapes scanned on **added lines only** — PEM headers, AWS `AKIA` keys, `sk_live_`
/ `sk_test_`, `ghp_` tokens, Slack `xox`-prefixed tokens. An added line carrying
`naso-allow-secret` is skipped, so a deliberate test fixture is possible without
disabling the rule.

Everything else is warn-only: committed build output, dependency manifests, and
names that merely look suspicious like `service-role.json`. Those used to block,
and a rule that fires on one file in four teaches an agent to ignore the output.

Findings report **path, line number and rule name only** — never the matched text
— so a warning is safe to paste into a chat or a CI log.

#### Scope

Name the prefixes a piece of work is supposed to touch and guard reports anything
staged outside them:

```bash
node .naso/scripts/guard.mjs . --staged --scope src,docs
NASO_SCOPE=src,docs node .naso/scripts/guard.mjs . --staged
```

Out-of-scope paths warn by default and refuse the commit under `--strict` or
`NASO_SCOPE_STRICT=1`. `AGENTS.md` and `.naso.lock` are always in scope, whatever
you configure — a briefing update is never an out-of-scope edit. With no scope
configured, guard skips the check entirely rather than guessing at one.

---

## The Briefing

`AGENTS.md` describes **what each area does and where it lives**. It is not a
file inventory. Inventories rot the day after they're written; a one-line
description of an area stays true for years.

Generated briefings carry two things at the top:

```markdown
<!-- naso-briefing -->
<!-- version: 2.1.0 -->
<!-- bootstrapped-by: mrval@MacBook-Pro -->
<!-- bootstrapped-at: 2026-10-01 -->
```

`validate.mjs` compares that version against this tool's `VERSION` and prints a
one-line notice when the briefing predates it, pointing at
`bootstrap.mjs --refresh` — which moves the stamp and reinstalls the hook without
touching what you wrote. The ownership line records who bootstrapped it and when,
and notes that later changes go through normal code review.

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
- **A statement checker.** `check-briefing.mjs` compares the claims in the
  briefing against the repository and fails on paths that don't exist, areas that
  were never mentioned, and markers left unfilled. The check the setup flow asks
  for, runnable at any time afterwards.

---

## Cross-Platform

Everything is Node.js core modules. No dependencies, no lockfile, no install
step.

The Git hook is the only genuinely platform-sensitive piece. Git for Windows
runs hooks through its bundled POSIX shell, so a `#!/bin/sh` script is correct
on both platforms and no `.cmd` variant is needed. What `bootstrap.mjs` handles
explicitly:

- Hooks directory from `git rev-parse --git-path hooks`, correct for plain
  clones, linked worktrees (where `.git` is a file), and `core.hooksPath`.
- LF line endings and no BOM — a BOM breaks the shebang, CRLF breaks the script.
- Embedded paths converted to forward slashes and single-quoted, so Windows paths
  with spaces and `C:\` prefixes survive the shell.
- `node` resolution fallback for hooks; if `node` isn't found the hook exits 0
  rather than blocking every commit.
- **Windows was not tested.** This repository targets Windows semantics where they
  matter (paths, hooks, the atomic lock), but runtime verification on Windows is
  outside this session's scope. Treat any Windows-specific behaviour as an
  unverified assumption and run the suite locally on Windows before relying on it
  there.

---

## Layout

```
.naso/
├── README.md
├── VERSION
├── AGENTS.template.md
├── SETUP_INSTRUCTIONS.md
├── scripts/
│   ├── bootstrap.mjs
│   ├── guard.mjs
│   ├── validate.mjs
│   ├── check-briefing.mjs
│   ├── lib.mjs
│   └── lock.mjs
└── test/
    └── naso.test.mjs
```

Seven files plus a test suite, no dependencies. Edit `VERSION` to bump the tool;
`validate.mjs` will tell every bootstrapped repo its briefing is behind.

```bash
node --test test/     # or just: node --test
```
