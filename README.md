# NASO — Agent Briefing System

NASO (Never Assume, Scan Once) generates a truthful `AGENTS.md` from your repository and keeps it consistent with what actually exists. One command sets it up: it reads the repository, shows you the plan, asks, and then writes. It copies a small toolset in, installs a minimal pre-commit gate, and gives five tools: `briefing`, `refresh`, `guide`, `validate`, and `doctor`.

The npm package is `naso-dev`, so every command below is `npx naso-dev <command>`.

## Why

An AI coding agent starts every session knowing nothing about your repository. Without a briefing it guesses at architecture and invents files. NASO writes that briefing by reading the repository, with no placeholders and no sections left to "fill later". The pre-commit hook keeps it true by refusing changes that leak secrets or go outside claimed scope, and by appending one line for a genuinely new area.

## Requirements

- Node.js 20 or newer
- Git 2.30 or newer
- A git repository

## Quick Start

One command, once per repository:

```bash
npx naso-dev
```

It reads the repository and prints what it found, asks what the plan depends on (commit the files or keep them local; the pre-commit hook, and what to do about a hook NASO did not write; whether to replace an existing NASO block), then lists every file it would write with its line count — and asks one question: **Write these files and install the hook?**

- **Accept** writes `AGENTS.md`, vendors the toolset into `.naso/tooling/`, installs `.git/hooks/pre-commit`, and — unless you pass `--track` — keeps both `.naso/` and `AGENTS.md` out of git via `.git/info/exclude`. An `AGENTS.md` git already tracks cannot be excluded: only `.naso/` is, and the plan says the NASO block will show in `git status` as a change to commit or drop.
- **Reject** writes nothing and reads the repository again. A second reject stops and offers to print a pre-filled support report; either way the repository is left byte-for-byte as it was.
- **Exclude an area** keeps one top-level directory out of the briefing and shows the plan again.
- **An existing `AGENTS.md` is never replaced.** The NASO block goes between `<!-- naso:start -->` and `<!-- naso:end -->`; everything outside those markers stays byte-identical.
- **Nothing is written before the last answer.** Not the hook, not the config, not a half-written briefing.

Add `--why` for the long-form rationale before you decide.

### Running it from a script

With no terminal — piped, in CI, or run by an agent — it prints the plan, writes nothing, and exits **2**, so a script can tell "not done" from "done". `--dry-run` prints the same plan and exits 0. To accept the plan you just read, add `--yes`:

```bash
npx naso-dev --yes
```

### `init` and `setup`

The two commands this replaces still work, print one deprecation line naming `npx naso-dev`, and are no longer listed in `--help`. Existing scripts and CI jobs calling them keep working.

## What gets installed

| Path                        | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                 | The briefing, inside its `naso:start` / `naso:end` markers. Never overwritten outside them.     |
| `.naso/tooling/*.mjs`       | A copy of the toolset, so the hook works with no network and no global install.                  |
| `.naso/tooling/VERSION`     | The version that copy was vendored from — the briefing stamp is compared against it.             |
| `.naso/config.json`         | Per-repository setup choices, including any areas you excluded.                                  |
| `.git/hooks/pre-commit`     | Runs the secret, scope, format and lint checks on staged files and keeps the briefing current.   |
| `.git/info/exclude`         | Keeps `.naso/` and `AGENTS.md` untracked locally (default mode), except a file git already tracks. Use `--track` to version them. |

The hook resolves `.naso/tooling/validate.mjs` from `git rev-parse --show-toplevel`, so it runs identically from a clone, from the npx cache, or from a teammate's machine that never installed the package. If the vendored script is ever missing, the hook prints one loud line and lets the commit through rather than failing silently.

## Commands

| Command                                                            | What it does                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `npx naso-dev [target] [options]`                                   | The setup flow: read, plan, ask, write. No TTY and no `--yes` prints the plan, writes nothing, exits 2.           |
| `npx naso-dev briefing [target] [check\|create\|refresh]`           | Verify `AGENTS.md` against disk, write the NASO block, or move the version stamp only.                            |
| `npx naso-dev refresh [target]`                                     | Re-copy the toolset, re-stamp the briefing, reinstall the hook. Never rewrites briefing prose or `.naso/config.json`. |
| `npx naso-dev guide <area-or-prefix> [target]`                      | The guide for one area: its paths, its checks, its boundary rules, and a ready-to-paste `NASO_SCOPE`.            |
| `npx naso-dev guide --list [target]`                                | The areas that exist, with their file counts. Unknown areas are an error, not an empty screen.                   |
| `npx naso-dev guide --tour [target]`                                | The read-through: every section of the briefing in reading order, plus the consistency check.                    |
| `npx naso-dev validate [target] [--staged] [--scope a,b] [--strict]` | The pre-commit gate, and the full CI run without `--staged`.                                                     |
| `npx naso-dev doctor [target]`                                      | Environment and install diagnostics: Node, git, hook, vendored copy, briefing consistency, leftovers.             |

All commands accept `--help`. `init` and `setup` are retired but still run; both are covered by the test suite.

## Options

- `--track` — commit `.naso/` and `AGENTS.md` instead of excluding them locally.
- `--no-hook` — do not install the pre-commit hook.
- `--hook-action <install|chain|skip|abort>` — what to do when `.git/hooks/pre-commit` already exists and NASO did not write it, or when `core.hooksPath` points at a directory git tracks (husky's `.husky/`). `chain` moves the existing hook, unchanged, to `pre-commit.pre-naso` and NASO's hook runs it first. The default is `skip`: NASO never overwrites a hook it did not write, and never writes into a tracked hooks directory unless you choose to. In a terminal this is asked as a question instead.
- `--exclude <prefix>` — keep an area out of the briefing. Repeatable. Saved to `.naso/config.json`.
- `--yes` — accept without prompting (CI and scripts).
- `--dry-run` — print the plan and stop. Writes nothing.
- `--force` — replace an existing `naso:start` / `naso:end` block. On a repository NASO already set up, `npx naso-dev --force` re-runs setup and regenerates the block; without it the run only reports what is installed. It never touches anything outside the markers.
- `--why` — print the long-form rationale for adopting NASO.
- `--no-color` — emit no escape codes, whatever the terminal or `FORCE_COLOR` says. `NO_COLOR` does the same, below this flag and above `FORCE_COLOR`.
- `--color` — colour the output even when it is a pipe.

Colour is on for a terminal and off for a pipe, which is why `npx naso-dev > plan.txt` gives you a readable file. Precedence, first match wins: `--no-color`, then `NO_COLOR`, then `FORCE_COLOR` (or `--color`; `FORCE_COLOR=0` means none), then whether the output is a terminal. npm sets `FORCE_COLOR` for the scripts it runs, so under `npm run` output may be coloured into a pipe; `NO_COLOR=1` or `--no-color` turns that off.

## Running it without installing

Every command is also a script you can run directly:

```bash
node <path-to-the-naso-dev-package>/bin/naso-dev.mjs
```

The path is wherever the package landed — a clone, `npm i -g`, or the npx cache. `npx naso-dev ...` and `node .../bin/naso-dev.mjs ...` run exactly the same code.

## Author

Created and maintained by **Valentine Asogwa (MrVal)**.

- GitHub: [@MrVal042](https://github.com/MrVal042)
- Email: contactmrval@gmail.com

## Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so the approach can be agreed before the work is done.

```bash
git clone https://github.com/MrVal042/.naso.git && cd .naso
npm ci
npm test
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Every behavior change needs a test that fails before the fix.

## Contributors

Thanks to everyone who has contributed. See the [contributors graph](https://github.com/MrVal042/.naso/graphs/contributors).

## Support

Email: contactmrval@gmail.com

## License

MIT — see [LICENSE](LICENSE).
