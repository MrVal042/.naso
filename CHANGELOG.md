# Changelog

## Unreleased (1.3.0)

### Added

- **Decisions survive sessions, accounts and agents.** `naso-dev decide --title … --source … --decision …` records a decision the team made, one file each, in the folder the repository already uses for decision records (else docs/decisions/). `--source` is required: the meeting, ticket, email or doc, by reference. Records are written as proposed; a person accepts them with `naso-dev decisions accept <id>`, rejects them, or supersedes one with a newer one. Nygard and MADR records are read as they are.
- **One list of decisions, linked from AGENTS.md.** The decisions folder's `README.md` lists every record, one line each with a link, between markers that `decide`, `decisions` and the pre-commit hook refresh. AGENTS.md carries only the rules (read the accepted decisions before proposing an approach, do not reopen one unless asked, record new ones as proposed, never accept one yourself) and one link to the list, so it stays the same size however many decisions there are.
- **`naso-dev decisions audit`** lists records that no longer hold and changes nothing: contradictions (an accepted decision another one supersedes), a missing status, no source, a scope that is gone, a proposal nobody settled in 14 days, a review date passed, a list that is missing or out of date. It exits 1 on contradictions.
- **The hook refuses a staged decision record with no status or title**, and refreshes the list and stages it with the records.
- **The agent prompt asks for unrecorded decisions** found in the docs to be proposed, citing the file.

### Fixed

- `--save-dev` and `--accept` are switches: `--save-dev ./repo` no longer takes the directory as its value.

## 1.2.0

The generated briefing changes shape, so this is a minor release.

### Added

- **The briefing says what the repository is, in any ecosystem.** A **What this is** line, read from every manifest in the repository (npm, Python, Go, Rust, Ruby, JVM, PHP, Dart): the framework and kind, or the kind the manifest itself implies (command-line tool, library), or that there is no manifest. Monorepos name each package. Setup shows it as **Stack** before anything is written.
- **Which Document Wins.** The briefing says that a file people wrote wins over the NASO block, and quotes, with file and line, every line in CLAUDE.md, AGENTS.md (outside the block), CONTRIBUTING.md or README.md that says which source wins.
- **Owners from CODEOWNERS.** Paths and their reviewers, the fallback owner, and plain paths that match no tracked file yet.
- **A source map.** Every folder under the source root (`src/`, `lib/`, `app/`, `pkg/`, `internal/`), with its file count and what the repository's own docs say it is for, cited; "no doc describes it" otherwise. Folders that share a name at two depths are flagged, and so are folders a doc names that are not in the repository.
- **The documented branch pattern.** A template such as `<type>/<KEY>-<n>-<slug>` in the contributing guide is stated in the briefing and checked by the hook, which warned only on branches that did not look like `x/y`.
- **Generated files name their source**: `src/api/schema.d.ts` is written by `npm run api:types` from `openapi.yaml`.
- **Stack Rules, only where the repository confirms them.** Routes for Expo Router and Next.js from the folder that exists; generated native folders only when `.gitignore` ignores them; Django and Rails migrations and `db/schema.rb`; `go.sum`, `Cargo.lock`, `./gradlew`, Prisma migrations, generated Dart files; public env prefixes (`EXPO_PUBLIC_`, `NEXT_PUBLIC_`, `VITE_`). One table row per framework in `tooling/stack.mjs`.
- **One command sets up and records the dev dependency.** In a repository with a `package.json`, `npx naso-dev` asks whether to add naso-dev to `devDependencies`, or to move it there from `dependencies`, and runs the repository's own package manager as the last step. `--save-dev` does the same from a script; `--yes` alone never runs the package manager. Setup is not run from an install script: npm hides that script's output and gives it no terminal, pnpm and bun do not run it by default, and it would run on every `npm ci`.
- **Every command NASO prints follows the repository's package manager.** A pnpm repository is told `pnpm dlx naso-dev`, or `pnpm exec naso-dev` once it is installed; yarn and bun get their own forms, and yarn 1, which has no `dlx`, gets npx. The manager comes from the `packageManager` field, then the lockfile, then the one that launched NASO. This covers help text, setup, doctor, refresh, guide, validate and the hook's message.
- **`CONTRIBUTING.md` is named as the authority on commit rules** when it writes them down; the count from history is a cross-check.
- **Generated files are marked.** A tracked file a script names as its output (`-o`, `--output`, `>`) is listed under Boundaries as regenerate-only, with whether CI fails when it changes, and the script is named as rewriting it.
- **The agent prompt asks for a correction backed by evidence.** The agent reads the rules the repository already wrote down, checks every claim in the NASO block, and corrects it between the markers only, citing a file for every change. It runs `npx naso-dev briefing` and hands back a diff without committing.
- **Setup reads like a guided installer.** In a terminal the plan is an overview: what the briefing covers, what must pass, warnings, and one row per destination with its exact line count, the toolset as a single row. A new answer, **Show details**, prints the full per-file plan and asks again. The install prints one ✓ line per step instead of repeating the plan, the follow-up commands drop the path when run from inside the repository, and the agent prompt is printed last. `--yes` and `--dry-run` still print the full plan.
- **Setup ends with "What you have now"**, built from what the run actually did, not from the plan.
- **Where To Look First links `CONTRIBUTING.md`** and a folder-structure or architecture doc under `docs/`.

### Fixed

- **The commit standard states the subject form the history uses.** A history of `type: KEY-12: summary` was described as `type(scope): summary`, which a push rule then rejects. Scope and ticket key are counted, and the count says it is of non-merge commits.
- **`.gitlab-ci.yml` is read as the gate.** A GitLab repository was told it "names no single gate". Its jobs are listed with what each runs, and an `include:` is reported as configuration NASO did not read. A GitHub job that runs several commands is described the same way.
- **Codegen is run with its diff check.** A CI job that regenerated a file and then ran `git diff --exit-code` was listed as the regenerate step alone, which rewrites the file and checks nothing. The two are now one command.
- **The vendored toolset no longer fails the repository's own lint and format.** The repository's ESLint read `.naso/tooling/` with its own rules (one team's `no-console` failed `npm run lint` on every NASO script), and with `--track` the hook refused to commit NASO's own files. Each vendored script starts with an `eslint-disable` line, and in a repository that uses Prettier, setup adds `.naso/` to `.prettierignore` as a listed write.
- **CI lines are split as shell, outside quotes.** `git diff --exit-code x || { echo 'stale; run y'; exit 1; }` came out as half a command that failed when run.
- **An unread `include:` is not "not run by CI".** Scripts outside the jobs NASO read are said to be possibly run by the included configuration.
- **The checker reads paths, not every word in backticks.** `lint` and `formatMoney` were reported MISSING; `src/app/(tabs)/` was skipped. A path has a slash, a `name.ext` shape, a dotfile name, or is a known extensionless file.
- **The hook is described as it is:** what it checks on staged files, that the branch check only warns, that it does not type-check, test or read the commit message, and that it lets a commit through when its toolset is missing.
- **Root-anchored ignore patterns come first**, so `/ios` and `/android` are not hidden behind `node_modules/`.
- **`guide` no longer calls a one-paragraph section empty.**
- **Scripts that rewrite files are not validation commands.** `format: prettier --write .` was listed beside `format:check`. Scripts passing `--write`, `--fix` or `-w` are named as rewriting files instead.
- **Three claims the scan could not back are gone.** "A bare relative import is the one mistake TypeScript will not catch" is replaced by the alias mapping alone. The language mix no longer counts AGENTS.md, and its total is every file with an extension, not the four shown. A TypeScript repository with no `"type"` field is no longer "CommonJS by default"; the line says that applies to its root `.js` files.
- **Credential warnings name real key files, not design tokens or templates.** `src/theme/tokens.ts` and `.env.example` were reported as credential-shaped. Templates are skipped, and a source file counts only when its name is key material.
- **Ignored credential files on this machine are shown at setup, by name.** `.env.production` that git ignores is listed on the setup screen, contents never read, and kept out of AGENTS.md: it is a fact about one machine, and a committed briefing would claim it for every teammate.
- **`*.p8` and `*.mobileprovision` are credentials**, not ignored build output.
- **The briefing says the hook runs only where setup installed it**, and that CI does not run it.

## 1.1.3

### Fixed

- **Install it as a dev dependency.** The README said `npm i naso-dev`, which puts it in a project's `dependencies`, where a production install and the app's build pick it up. It now says `npm i -D naso-dev` (with the pnpm, yarn and bun forms), or no install at all with `npx`. `refresh` suggests `npm i -D naso-dev@latest` instead of a global install.

## 1.1.2

### Changed

- **No dependencies.** `npm i -D naso-dev` installs naso-dev and nothing else. `picocolors` is replaced by plain ANSI codes in `ui.mjs`, and `@clack/prompts` by `prompt.mjs`, a confirm and select on Node's own readline that look and answer the same: arrow keys or j/k, Enter, y/n, Ctrl+C or Escape.

## 1.1.1

1.1.0 was published from `ceab466`. Everything below is relative to it.

### Fixed

- **`--yes <dir>`, `--dry-run <dir>` and `-y` work.** A switch no longer takes the next argument as its value, so `npx naso-dev --yes <dir>` — the command the flow prints — sets up `<dir>` instead of doing nothing. `--exclude` keeps every value when repeated.
- **No user or machine name is recorded.** `user@hostname` is gone from the banner, the AGENTS.md header and `.naso/config.json`. `refresh` removes `generatedBy` from an existing config.json and changes nothing else.
- **The pre-commit gate runs the repository's package manager.** `validate` invoked `npm` and `npx` in pnpm, yarn and bun repositories.
- **A pre-commit hook NASO did not write no longer blocks setup.** It is shown in the plan as `Hook: existing hook at <path>`, with chain, skip (the default) or abort; `--hook-action` makes the choice from a script. Chain moves the existing hook, unchanged, to `pre-commit.pre-naso` and runs it first. Nothing NASO did not write is overwritten, and a `core.hooksPath` directory git tracks is written to only when chosen. A hand-written AGENTS.md is appended to instead of being treated as an existing install. `--force` and the replace-the-block question are reachable.
- **Boundaries names every `verify:*` script**, including `verify:boundaries` and checks not named for a boundary, and marks one as run only when the parsed gate runs it.
- **Counts and the staging rule follow git.** A first `--track` run no longer subtracts an AGENTS.md that is not in the index, and whether AGENTS.md is tracked is read from the index and `git check-ignore`, not from the flag.
- **`@a` and `@a/*` are one alias.** A `.js` file's module system comes from its folder's own package.json. Tests under `test/` are no longer called co-located.
- `refresh` reports a briefing stamped by a newer NASO; `validate`'s full run honours `--scope` and `--strict`; failed deletes of leftovers and locks are reported instead of swallowed.
- **A hand-written AGENTS.md no longer fails setup.** The consistency check read the whole file, so words the owner put in backticks (`web`, `sk_live`) were reported as missing paths and setup exited 1 after writing. Only the NASO block is checked now.
- **A tracked AGENTS.md is not put in `.git/info/exclude`.** An exclude line cannot hide a tracked file, so the NASO block showed up in `git status` while setup said it was kept out of git. Only `.naso` is excluded, and the plan and the result say the block will show as a change.
- **AGENTS.md is no longer a "leftover".** Setup listed the repository's own briefing under *Leftovers to remove*, and `doctor` warned about it on every healthy install.
- **A test script that runs a script file makes no coverage claim.** `test:workspace: ./tooling/scripts/test-workspace.sh` was read as "the only tests are under that path", and every other test file was reported as run by nothing.
- **Long warnings name five paths and count the rest**, on screen and in AGENTS.md. A monorepo's 155 test paths cost thousands of tokens in every session that read the briefing.
- **A repository with no package.json is not told to use npm.** A Python project gets its dependency files (`requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py`) and lockfile tool instead, and the entry-point note no longer mentions package.json.
- **The area package.json `"bin"` points into is the published command**, not "developer scripts", and `lib.*` is an entry point only as Rust's `lib.rs`.
- **An area the published entry imports is named for that**, not by its folder name: NASO's own `tooling/` was "developer scripts" although it is everything the command runs. Literal relative imports only, one hop.

### Changed

- **Plan first, then one question.** `npx naso-dev` asks what the plan depends on, lists every file it would write with its line count and the hook decision, then asks: *Write these files and install the hook?* — accept, reject, or exclude an area. Reject reads the repository again; a second reject offers exit or a support report, and both leave the repository byte-identical. `naso-dev setup` runs this flow.
- **No terminal and no `--yes` exits 2**, naming `--yes` and `--dry-run`. `--dry-run` exits 0.
- **`FORCE_COLOR` is honoured.** Precedence: `--no-color`, `NO_COLOR`, `FORCE_COLOR` or `--color`, then whether stdout is a terminal.
- The opening screen uses one label column.
- **The briefing reaches Claude Code.** Claude Code reads `CLAUDE.md`, not `AGENTS.md`, so a briefing with no link was never loaded. Setup writes a `CLAUDE.md` holding one `@AGENTS.md` line when there is none (excluded locally like `AGENTS.md`), appends the line to an untracked one, and leaves a tracked one alone in local mode, saying what to add; `--track` appends it. `doctor` reports the link.
- **The commit standard is read from the repository's history.** The subject format is stated only when most of the last 50 commits follow it, with the types they use; the co-author rule only when none carries a trailer. Generic rules ("inventory first", "the body explains why") are gone, and *Final Response Expectations* is replaced by *When Done*, which names the commands this repository declares. Scope and Secrets are shorter.
- **Setup warns about machine and runtime files tracked in git**: `.DS_Store`, `Thumbs.db`, Python bytecode, local databases. Paths only, on the setup screen, never in AGENTS.md.
- **`briefing.mjs` is split** into `scan.mjs`, `render.mjs` and `check.mjs`; `briefing.mjs` re-exports all three, so every import of it keeps working. The test suite is split by topic, with shared fixtures in `test/helpers.mjs`; `npm test` names `test/*.test.mjs`.

## Planned for 1.2.0

- A scope-strictness question during setup.
- A never-touch-paths question during setup.
- A target-agents question during setup.
- Refresh mode: show a diff of what would change and ask, instead of reporting.
- Windows shell handling (spawning `.cmd` package-manager shims). Windows is not supported until then.
