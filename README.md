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
npx naso-dev@latest --save-dev
```

`--save-dev` records naso-dev in your project's `devDependencies`, never `dependencies`, as an exact version when the repository pins its versions (`save-exact` in `.npmrc`, a Renovate config that pins, or every dependency already exact): it is a development tool, so production installs and your app's build leave it out. In a repository without a `package.json` the flag does nothing. `@latest` makes npx fetch the current release instead of reusing an older copy it cached.

It works like a guided installer. In order:

1. **Reads** the repository and shows what it found: branch, files, areas, language.
2. **Asks** what the plan depends on: commit the files or keep them local; the pre-commit hook, and what to do about a hook NASO did not write; whether to replace an existing NASO block; whether to record naso-dev in `devDependencies`.
3. **Shows the plan** as an overview: what the briefing covers, what must pass, any warning, and one row per file it would write with its exact line count (the whole toolset is one row).
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

### What you will see

A first run in a NestJS API with a `package.json`, shortened. Your branch, counts and CI will differ.

**1. It reads the repository.** npx asks once to download naso-dev, then NASO says what it found and what it is about to do. Nothing has been written yet.

```text
$ npx naso-dev@latest --save-dev
Need to install the following packages:
naso-dev@1.3.0
Ok to proceed? (y) y

NASO 1.3.0  /path/to/acme-api

## This repository

Branch            feature/bootstrap
Files             136 tracked in the git index
Areas             4 top-level directories (docs, openapi, src, test)
Stack             A NestJS API service
Language          TypeScript, 106 of 136 files

What this does    reads this repository, writes an AGENTS.md briefing
                  that says what every area is for and what must pass before
                  work counts as done, then copies a small toolset into .naso/
                  and installs a pre-commit gate to keep the briefing true.

Before you accept nothing at all is written. Answering no leaves this
                  repository exactly as it is, and that is a valid outcome.
```

**2. It asks what the plan depends on.** Enter takes the default.

```text
◇  Questions
   Answer with Enter to accept the default. Nothing is written until you accept the plan.

◇  Commit AGENTS.md and .naso/ to git? (No keeps them local to this machine.)
   Yes

◇  Install the pre-commit gate?
   Yes
```

If `AGENTS.md` already has a NASO block, it also asks whether to replace it. Everything outside the markers is kept either way. Because `--save-dev` was passed, it does not ask about `devDependencies`.

**3. It shows the plan and asks once.** Every file it would write, with its line count. `package.json` changes last, through your own package manager.

```text
The plan for acme-api  nothing is written until you accept

  The briefing covers 4 areas: docs/, openapi/, src/, test/ from 136 files on feature/bootstrap.
  What must pass: .gitlab-ci.yml (3 CI jobs)

## Files this writes

  AGENTS.md                new, 152 lines   (the briefing)
  CLAUDE.md                new, 1 line      (makes Claude Code load the briefing)
  .naso/tooling/           new, 9909 lines  (19 files; the hook runs this copy)
  .naso/config.json        new, 8 lines     (the choices you made here)
  .git/hooks/pre-commit    new, 47 lines    (the gate, on this machine)
  .prettierignore          append 1 line
  package.json             changed  (devDependencies, by npm, last)
  package-lock.json        changed  (by npm, with node_modules/)

  Last, `npm install --save-dev naso-dev@1.3.0`, the only step that uses the network.

◆  Write these files and install the hook?
   ● Accept (write exactly the files listed above)
   ○ Show details
   ○ Reject
   ○ Exclude an area
```

**4. It writes, checks, and hands over to your coding agent.**

```text
## Accepted - writing

✓ AGENTS.md: wrote the NASO block, 152 lines
✓ CLAUDE.md: wrote `@AGENTS.md`, so Claude Code loads the briefing
✓ .naso/tooling/: copied 19 files; the hook runs this copy, not the package
✓ .naso/config.json: wrote the settings this run used
✓ .prettierignore: added .naso/, so prettier --check leaves the toolset alone
✓ pre-commit hook: installed (.git/hooks/pre-commit)
✓ git: .naso/ and AGENTS.md are yours to commit (--track)
✓ devDependencies: added naso-dev with `npm install --save-dev naso-dev@1.3.0`

## Verify

Briefing is consistent with the repository: 38 path claim(s) verified, 4 top-level area(s) covered, no placeholders left.

## What you have now

- A briefing every coding agent that reads AGENTS.md starts from, with 38 path claims checked against this repository.
- Claude Code loads it through CLAUDE.md.
- Every commit on this machine is checked before it lands: secret-shaped lines, files outside NASO_SCOPE, format and lint on staged files, and a briefing line for any new top-level area.
- naso-dev is in devDependencies: teammates get this version from an ordinary install, and production installs leave it out.

## Last step: hand this to your coding agent
```

It ends with a prompt to paste into your coding agent. The agent checks every claim in the NASO block against the rules your repository already wrote down, corrects or removes what is wrong, adds what an agent would otherwise get wrong, cites a file and line for every change, proposes the decisions your docs already made, and gives you a diff to review without committing. Its report ends with what NASO gives your repository, counted.

`npx naso-dev review` prints that prompt again whenever you want it, built from the repository as it is then. It names the rule files your repository has, what `briefing` and `decisions audit` report today, and the decisions waiting for a person. On a second review it asks the agent to check what changed since the first one instead of starting over.

### Adding it to a project

`npx naso-dev --save-dev` is the whole install. With `--save-dev`, NASO runs your package manager (`npm install --save-dev`, `pnpm add --save-dev`, `yarn add --dev` or `bun add --dev`) as the last step, after everything else is written, so teammates get the same version from an ordinary install. If someone already ran `npm i naso-dev` and it landed in `dependencies`, it moves it to `devDependencies`. Without the flag, a terminal run asks **Add naso-dev to devDependencies?** (default yes); `--yes` alone never runs the package manager.

Installing the package is not setup. `npm i naso-dev` runs nothing and asks nothing: there is no install script, so no questions, no `AGENTS.md`, no hook. It only adds the package, and without `-D` it adds it to `dependencies`. If you install it yourself, always do it as a dev dependency (`npm i -D naso-dev`, `pnpm add -D naso-dev`, `yarn add -D naso-dev` or `bun add -d naso-dev`), then run `npx naso-dev --save-dev` to set up.

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
npx naso-dev --yes --save-dev
```

### `init` and `setup`

The two commands this replaces still work, print one deprecation line naming `npx naso-dev`, and are no longer listed in `--help`. Existing scripts and CI jobs calling them keep working.

## What the briefing says the repository is

The briefing opens with one line, **What this is**, read from the manifests the repository has, in any ecosystem: package.json, pyproject.toml and requirements files, go.mod, Cargo.toml, Gemfile, pom.xml and Gradle, composer.json, pubspec.yaml. Every manifest counts, not only the root one, so a monorepo names each package by its own:

> A pnpm monorepo (`pnpm-workspace.yaml`) of 2 packages: `apps/web/` is a Next.js web app; `services/api/` is a NestJS API service.

Frameworks it names: Expo, React Native, Next.js, Nuxt, SvelteKit, Remix, Astro, Angular, Electron, NestJS, Fastify, Hono, Express, Vite, Django, FastAPI, Flask, Rails, Laravel, Symfony, Spring Boot, Flutter, and Go and Rust services and CLIs by their libraries. With none of those, the kind comes from the manifest itself: package.json `"bin"` is a command-line tool, `"exports"` or `"main"` a library, `src/main.rs` a Rust program. A repository with no manifest is told so, and no stack is named.

**Stack Rules** follows, only when there are any. Every rule is checked against this repository before it is written: "every file under `src/app/` is a route" needs that folder and the router dependency; "ios/ and android/ are generated" needs `.gitignore` to ignore them; "`db/schema.rb` is generated" needs the file. A rule from one stack never appears in another's briefing. The table is in `tooling/stack.mjs`, one row per framework; adding a row changes no other.

## Rules the repository already wrote down

These work the same in any repository, and say nothing where the file is absent:

- **Which Document Wins** comes first. A file people wrote wins over the NASO block, and every line in `CLAUDE.md`, `AGENTS.md` (outside the block), `CONTRIBUTING.md` or `README.md` that says which source wins is quoted with its file and line.
- **When This Block Is Wrong** follows: an agent that finds a line the repository contradicts corrects it between the markers, citing the file, instead of working around it, and `npx naso-dev review` gives it the full review.
- **Owners** lists CODEOWNERS paths with their reviewers, and names plain paths that match no tracked file yet.
- **Source Map** lists every folder under the source root with its file count and the purpose the repository's own docs give it, cited. A folder no doc describes says so. Folders sharing a name at two depths (`src/auth/` and `src/features/auth/`) and folders a doc names that no longer exist are flagged.
- **Branch names** follow the template the contributing guide writes down (`<type>/<KEY>-<n>-<slug>`), and the hook warns on any other branch. With no template, the hook only checks for a `prefix/name` shape.
- **Generated files** name the script that writes them and the source it reads.

## Decisions: say it once

A decision made in a meeting, a ticket, an email or a chat is lost to the next AI session, the next account and the next agent unless it is written where all of them look. NASO keeps each one in its own file, lists them all in the decisions folder's `README.md` (one line per decision, linked to its record), and gives AGENTS.md only the rules and one link to that list, so AGENTS.md stays the same size however many decisions a team makes.

```bash
npx naso-dev decide --title "Use REST for the customer API" \
  --decision "The app calls only REST endpoints of customer-api." \
  --why "One contract for web and mobile" \
  --considered "GraphQL — no team owns a schema" \
  --source "PO email, 2026-10-14" --by "product owner" --applies src/api/
npx naso-dev decisions                 # list
npx naso-dev decisions accept 0004     # a person accepts it
npx naso-dev decisions supersede 0001 --by 0004
npx naso-dev decisions audit           # what no longer holds; changes nothing
```

- **Where:** the folder the repository already uses for decision records (`docs/adr/`, `docs/decisions/`, an `.adr-dir`…), else `docs/decisions/`. Nygard and MADR records are read as they are.
- **Agents propose, people accept.** `decide` writes `proposed`; only `accept` makes a decision binding, and the briefing tells agents never to run it themselves.
- **Every record has a source**, by reference: "PO email, 2026-10-14", not the email.
- **Say it once.** `decide` refuses a title that is already recorded unless the new record supersedes it, and `--considered` keeps the options turned down, so no later session offers one again.
- **Every session uses them.** AGENTS.md tells an agent to check the list before asking the person a question, and to record a decision made in the session before the session ends.
- **Nothing is deleted.** The audit reports contradictions, missing sources, scopes that are gone, unsettled proposals and passed review dates; a person supersedes or rejects.
- **One list, one link.** The list sits between `<!-- naso:decisions:start -->` and `<!-- naso:decisions:end -->` in the decisions folder's `README.md`, accepted first, then proposed, then rejected or superseded; anything the team writes around the markers is kept. These commands and the pre-commit hook refresh it, and the hook stages it with the records. AGENTS.md links to it and tells every agent to read it before proposing an approach, so Claude Code, Codex, Cursor or Copilot start from the same decisions in a new session, on a new account or on another machine.

## What gets installed

| Path                        | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                 | The briefing, inside its `naso:start` / `naso:end` markers. Never overwritten outside them.     |
| `CLAUDE.md`                 | One `@AGENTS.md` line, so Claude Code (which reads `CLAUDE.md`, not `AGENTS.md`) loads the briefing. Written only when there is no `CLAUDE.md` or yours is untracked; a tracked one is left alone unless you pass `--track`, and setup says what to add. |
| `.naso/tooling/*.mjs`       | A copy of the toolset, so the hook works with no network and no global install. Each file starts with `/* eslint-disable */`, so your lint rules do not apply to NASO's code. |
| `.dockerignore`             | One `.naso/` line under its own comment, only when the file already exists, so a Docker build does not copy the toolset into the image. Docker does not read `.git/info/exclude`. |
| `.prettierignore`           | One `.naso/` line, only in a repository that uses Prettier, so `prettier --check .` leaves the toolset alone. Prettier does not read `.git/info/exclude`. |
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
| `npx naso-dev review [target]`                                     | Print the prompt for your coding agent, built from this repository as it is now: its rule files, the check, decisions waiting for a person, and whether the block was reviewed before. |
| `npx naso-dev guide <area-or-prefix> [target]`                      | The guide for one area: its paths, its checks, its boundary rules, and a ready-to-paste `NASO_SCOPE`.            |
| `npx naso-dev guide --list [target]`                                | The areas that exist, with their file counts. Unknown areas are an error, not an empty screen.                   |
| `npx naso-dev guide --tour [target]`                                | The read-through: every section of the briefing in reading order, plus the consistency check.                    |
| `npx naso-dev validate [target] [--staged] [--scope a,b] [--strict]` | The pre-commit gate, and the full CI run without `--staged`.                                                     |
| `npx naso-dev decide --title … --source … --decision …`           | Record a decision the team made, as proposed, with where it was made. |
| `npx naso-dev decisions [accept\|reject\|supersede\|audit\|sync]` | List, settle or audit the recorded decisions. The audit changes nothing. |
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
