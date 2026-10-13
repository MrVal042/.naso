# NASO — Agent Briefing System

NASO (Never Assume, Scan Once) generates a truthful `AGENTS.md` from your repository and keeps it consistent with what actually exists. One command sets it up: it reads the repository, shows you the plan, asks, and then writes. It copies a small toolset in, installs a minimal pre-commit gate, and gives five tools: `briefing`, `refresh`, `guide`, `validate`, and `doctor`. It has no dependencies, so installing it adds naso-dev and nothing else.

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

It works like a guided installer. In order:

1. **Reads** the repository and shows what it found: branch, files, areas, language.
2. **Asks** what the plan depends on: commit the files or keep them local; the pre-commit hook, and what to do about a hook NASO did not write; whether to replace an existing NASO block; whether to record naso-dev in `devDependencies`.
3. **Shows the plan** as an overview: what the briefing covers, what must pass, any warning, and one row per file it would write with its exact line count (the 16-file toolset is one row).
4. **Asks once:** *Write these files and install the hook?* Accept, Show details, Reject, or Exclude an area.
5. **Installs**, one ✓ line per step, verifies the briefing against the repository, and says what you have now.
6. **Ends with a prompt for your coding agent**, which finishes the job: it checks the briefing against the rules your repository already wrote down and corrects it.

- **Accept** writes `AGENTS.md`, links it from `CLAUDE.md` for Claude Code, vendors the toolset into `.naso/tooling/`, installs `.git/hooks/pre-commit`, and — unless you pass `--track` — keeps both `.naso/` and `AGENTS.md` out of git via `.git/info/exclude`. An `AGENTS.md` git already tracks cannot be excluded: only `.naso/` is, and the plan says the NASO block will show in `git status` as a change to commit or drop.
- **Show details** prints every file one by one, what the briefing will say, and why each change is made, then asks again. It is not a rejection.
- **Reject** writes nothing and reads the repository again. A second reject stops and offers to print a pre-filled support report; either way the repository is left byte-for-byte as it was.
- **Exclude an area** keeps one top-level directory out of the briefing and shows the plan again.
- **An existing `AGENTS.md` is never replaced.** The NASO block goes between `<!-- naso:start -->` and `<!-- naso:end -->`; everything outside those markers stays byte-identical.
- **Nothing is written before the last answer.** Not the hook, not the config, not a half-written briefing.

Arrow keys (or j/k) move between answers, Enter picks one, and y or n answers a yes/no question at once. Ctrl+C or Escape cancels at any question, and nothing is written.

Add `--why` for the long-form rationale before you decide.

### Adding it to a project

`npx naso-dev` is the whole install. When the repository has a `package.json`, the questions include one more: **Add naso-dev to devDependencies?** Yes runs your package manager (`npm install --save-dev`, `pnpm add --save-dev`, `yarn add --dev` or `bun add --dev`) as the last step, after everything else is written, so teammates get the same version from an ordinary install. If someone already ran `npm i naso-dev` and it landed in `dependencies`, the question offers to move it instead. From a script, pass `--save-dev`; `--yes` alone never runs the package manager.

It belongs in `devDependencies` because nothing in your app imports it: a production install (`npm ci --omit=dev`) and your app's build leave it out. The pre-commit hook does not need it installed at all: it runs the copy in `.naso/tooling/`.

Why not set up from `npm i naso-dev` itself: npm 7 and later run a package's install script with its output hidden and no terminal to answer from, pnpm and bun do not run it unless the project allows it, and npm writes `package.json` after the script has run. An install script would also run on every `npm ci` in CI and on every teammate's machine. One `npx` command does the same job without any of that.

### Your package manager, not just npx

Every command NASO prints for you to run is spelled for the package manager this repository uses: its `packageManager` field, then its lockfile, then the manager that launched NASO, then npm.

| Repository uses | naso-dev installed here | not installed |
| --------------- | ----------------------- | ------------- |
| npm             | `npx naso-dev`          | `npx naso-dev` |
| pnpm            | `pnpm exec naso-dev`    | `pnpm dlx naso-dev` |
| yarn 2+         | `yarn naso-dev`         | `yarn dlx naso-dev` |
| yarn 1          | `yarn naso-dev`         | `npx naso-dev` (yarn 1 has no `dlx`) |
| bun             | `bunx naso-dev`         | `bunx naso-dev` |

The same goes for the dev dependency step, the upgrade hint `refresh` prints, and the message the pre-commit hook prints when its toolset is missing. The commands in AGENTS.md (`pnpm run lint`) already followed the repository's manager.

### When it finishes

Setup ends with two things, in this order:

- **What you have now.** One line per thing the run actually did: how many path claims were checked, whether Claude Code loads the briefing, what the hook checks on this machine, whether naso-dev was recorded in `devDependencies`, and whether anything reached git history. Nothing that was skipped or failed is listed.
- **A prompt for your coding agent**, printed last so it is the next thing to do. It asks the agent to read the rules this repository already wrote down (CONTRIBUTING, CODEOWNERS, review templates, CI, docs), check every claim in the NASO block against them, and correct the block. Every change must cite the file that proves it and stay between the markers. The agent runs `npx naso-dev briefing` before reporting, never opens credential files, and does not commit: you get a diff to review.

`--yes` and `--dry-run` print the full plan instead of the overview, since nobody is there to ask for details.

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
| `CLAUDE.md`                 | One `@AGENTS.md` line, so Claude Code (which reads `CLAUDE.md`, not `AGENTS.md`) loads the briefing. Written only when there is no `CLAUDE.md` or yours is untracked; a tracked one is left alone unless you pass `--track`, and setup says what to add. |
| `.naso/tooling/*.mjs`       | A copy of the toolset, so the hook works with no network and no global install.                  |
| `.naso/tooling/VERSION`     | The version that copy was vendored from — the briefing stamp is compared against it.             |
| `.naso/config.json`         | Per-repository setup choices, including any areas you excluded.                                  |
| `.git/hooks/pre-commit`     | Runs the secret, scope, format and lint checks on staged files and keeps the briefing current.   |
| `.git/info/exclude`         | Keeps `.naso/`, `AGENTS.md` and a `CLAUDE.md` NASO created untracked locally (default mode), except a file git already tracks. Use `--track` to version them. |

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
| `npx naso-dev doctor [target]`                                      | Environment and install diagnostics: Node, git, hook, vendored copy, briefing consistency, the Claude Code link, leftovers. |

All commands accept `--help`. `init` and `setup` are retired but still run; both are covered by the test suite.

## Options

- `--track` — commit `.naso/` and `AGENTS.md` instead of excluding them locally.
- `--no-hook` — do not install the pre-commit hook.
- `--hook-action <install|chain|skip|abort>` — what to do when `.git/hooks/pre-commit` already exists and NASO did not write it, or when `core.hooksPath` points at a directory git tracks (husky's `.husky/`). `chain` moves the existing hook, unchanged, to `pre-commit.pre-naso` and NASO's hook runs it first. The default is `skip`: NASO never overwrites a hook it did not write, and never writes into a tracked hooks directory unless you choose to. In a terminal this is asked as a question instead.
- `--exclude <prefix>` — keep an area out of the briefing. Repeatable. Saved to `.naso/config.json`.
- `--save-dev` — record naso-dev in `devDependencies` with this repository's package manager, as the last step. Asked as a question in a terminal; from a script, `--yes` alone never runs the package manager.
- `--yes`, `-y` — accept without prompting (CI and scripts).
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

The path is wherever the package landed — a clone, `node_modules/naso-dev` after `npm i -D`, or the npx cache. `npx naso-dev ...` and `node .../bin/naso-dev.mjs ...` run exactly the same code.

## Author

Created and maintained by **Valentine Asogwa (MrVal)**.

- GitHub: [@MrVal042](https://github.com/MrVal042)
- Email: contactmrval@gmail.com

## Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so the approach can be agreed before the work is done.

```bash
git clone https://github.com/MrVal042/.naso.git && cd .naso
npm test
```

There is nothing to install first: NASO has no dependencies, and the tests run on Node's built-in test runner. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Every behavior change needs a test that fails before the fix.

## Contributors

Thanks to everyone who has contributed. See the [contributors graph](https://github.com/MrVal042/.naso/graphs/contributors).

## Support

Email: contactmrval@gmail.com

## License

MIT — see [LICENSE](LICENSE).
