# Changelog

## 1.5.3

### Fixed

- **A fresh clone gets one instruction for the hook.** The block said a clone has no hook "until setup runs there", while the toolset README said refresh reinstalls it. The block, the toolset README and `doctor` (when the hook is missing) now all name `npx naso-dev refresh`, which installs the hook and, at the version already vendored, changes nothing else.
- **The block drops lines that do not change what an agent does.** Agents removed all of these in both field repositories: "Local excludes" (one machine's `.git/info/exclude`), "Ignored paths" and "Re-included" (a restatement of `.gitignore`), the "Language mix" counts, and a second "Import aliases" line under Boundaries (the mapping is stated once, under Code Conventions, with the files that declare it). Ignored paths that carry a rule stay: credentials, generated files, and files the repository says are not edited by hand. The Feature To Folder Map lists only folders whose name says what they hold, without file counts, and is left out when none does.
- **The vendored files no longer make the repository's own lint warn.** Every vendored script starts with `/* eslint-disable */`, and ESLint 9 reports an unused disable directive by default, so `eslint .` warned about `.naso/tooling/` (3 warnings in the field). Setup added `.naso/` to `.prettierignore` but never to ESLint. It now adds `{ ignores: ['.naso/'] }` as the first entry of a flat config's exported array (plain array, `defineConfig`, `tseslint.config`, or a named array), in the config's own quote style and indent, or `.naso/` to `.eslintignore` for a legacy config. A config it cannot place the line in is left alone and the plan says what to add. `--no-ignore-files` opts out of every ignore edit: `.prettierignore`, `.dockerignore` and ESLint.
- **`doctor` runs the repository's ESLint on `.naso/`.** With an ESLint config and `node_modules/eslint` installed, it reports anything ESLint prints for the vendored files, with the fix.
- **`.naso/config.json` no longer reads as the current version.** Its `"version"` stayed at the setup version after every refresh, by design, and two separate reviews reported it as a mismatch with the toolset. Setup now writes `setupVersion`; a config with `"version"` is still read. `doctor` prints "setup ran with X (refresh never rewrites it)".
- **A curly-quoted citation is checked against the lines it cites.** Only citations past the end of a file were reported; one inside the file could point at the wrong sentence, or misquote it, and pass. When the block quotes text in “…” next to a `` `file` line N `` or `lines N–M` citation, `briefing` now looks for the quote in those lines (whitespace, list markers and Markdown emphasis normalised) and reports a mismatch as WRONG, with the file, the line and the first differing word.
- **The version notes say which version to run.** "Run `npx naso-dev refresh` with the version the team uses" left the reader to guess. `briefing`, `review` and `refresh` now read the exact devDependency and lockfile version: a toolset behind the pin gets `npx naso-dev@<pinned> refresh`; a toolset ahead of it gets the exact install of the toolset's version, since refresh refuses to move it back. Without a pin, the note names the running version's own refresh. `doctor` prints the same advice on a "naso-dev in package.json" row.
- **`review` asks for a full review while the block is uncommitted.** It told a second review to diff from the last commit that touched AGENTS.md; with the block added but not committed, that commit predates NASO and the diff was the repository's whole history (184 files in the field). When HEAD's AGENTS.md has no `naso:start` marker, it now says the block is uncommitted and asks for the whole block to be reviewed.
- **`review` no longer proposes decisions that are already recorded.** A Decided row counted as recorded only when a record's source named its exact line, so records citing "docs/architecture.md section 2" matched nothing and 9 of the 10 rows listed in the field were already recorded. A row now counts as cited when a record's source names its file and its line, a line range or a section heading that holds it, or the record states the same decision.
- **A Decided row that names another owner is listed apart.** "Decided (customer-api)" belongs to another repository; `review` lists it as decided elsewhere, not as a decision to propose here.
- **`decide` warns when the line it cites is already cited.** Another record citing the same line, by number, range or section, is named, with how to supersede it. A source that names a file without a line gets a note asking for "<file> line <n>".
- **`review` no longer lists proposed decisions as the repository's own rules.** Its "own rules" list matched every Markdown file under `docs/`, so the agent's unaccepted proposals in `docs/decisions/` were named as the authority it checked itself against. The decisions folder is left out; accepted records are listed under "Decisions a person accepted".
- **`decide` no longer cuts a file name mid-word.** Names were cut at 50 characters ("…-no-ve.md", "…-with-react-ho.md"). They are now cut at the last hyphen before 50.
- **`refresh` and `briefing refresh` say what they changed.** They printed "No prose touched" and "Briefing content untouched", but since 1.5.2 they also note the refresh on the "Generated by" line. They now say so.

### Added

- **Setup derives the toolchain facts agents had to add by hand.** Each is read from the file that states it, without running it, and cited:
  - **Prettier options** (`.prettierrc`, `prettier.config.*` or package.json `"prettier"`): quotes, trailing commas, width and the other layout options, on the Format line.
  - **Jest preset, module mocks and setup files** (package.json `"jest"` or `jest.config.*`), on their own line under Code Conventions.
  - **Expo runtime version policy and experiments** (`app.config.*` or `app.json`): what the policy asks when native code changes ("bump `version`"), and what `typedRoutes` and `reactCompiler` change, under Stack Rules.
  - **Metro transformers** (`metro.config.*`): an SVG transformer means an `.svg` import is a component, not an image source.
  - **Merge request checklist items** (`.gitlab/merge_request_templates/*.md`, `.github/pull_request_template.md`), quoted with file and line in a new Merge Request Checklist section.
  - **Merge mode, approval rules and commit-rule exceptions** from CONTRIBUTING ("Revert messages are accepted", squash, fast-forward, code owners who may self-approve), quoted under Commit Standard.
  - **Generated, git-ignored framework files** (`.expo/`, `expo-env.d.ts`, `.next/`, `next-env.d.ts` and others) and whether type-checking needs them, read from `.gitignore` and tsconfig `"include"` and `"files"`, under Boundaries.
  - **Decisions written outside a table**: a dated "decided" comment in a config file such as `app.config.ts`, and "decided" lines in CONTRIBUTING, CODEOWNERS and docs, join the Decided rows `review` asks the agent to propose. In the field setup recorded 6 decisions and the agents found 36 more.
- **The review prompt checks for another writer.** In a workspace with several agent sessions, another session staged everything mid-review, unrelated files included. The agent now records `git rev-parse HEAD` and `git write-tree` at the start and checks both again before the report; since it never stages, a change it did not make means another writer, and it stops and says so with the diff between the two trees.
- **The review prompt ends with a commit plan.** In repositories with one ticket per branch, the NASO adoption landed on whatever branch was checked out. The prompt names the current branch and the branch rule `CONTRIBUTING.md` states, and the report ends with the branch the rules require, the exact files to stage, staged files that are not NASO's, the commit message, and a final "Ready to commit: yes" or "no" line with the blockers.
- **The review prompt runs the whole toolchain on NASO's files.** The agent runs every check-only tool the repository and its CI use (lint, format check, typecheck, tests, and the secret scanner if installed, such as `gitleaks dir . --redact`) on `.naso/` and the decisions folder, and reports the config change for each that complains. A test keeps the vendored toolset and the decisions folder clean under gitleaks' key-shaped rules, and under gitleaks itself when it is installed (8.30.1 finds nothing in this release).

## 1.5.2

### Fixed

- **`refresh` no longer writes a false "Generated by" line.** 1.5.1 replaced the version there, giving "Generated by NASO 1.5.1 on" a date before 1.5.1 existed. The original version and date now stay, followed by "(refreshed to X on Y)".
- **`refresh` will not move a newer toolset back.** Run from an older install (node_modules still on what package.json records), it re-copied the older scripts over a teammate's upgrade. It now changes nothing, says how to bring the package up to the toolset, and moves the toolset back only with `--force`.
- **A decision count written into the block is reported when it goes stale.** "All 6 there are proposed" stayed after the next `decide`; `briefing` now reports it as WRONG, with the real count.
- **A line citation past the end of its file is reported.** `briefing` reads each `` `file` line N `` and `lines N–M` citation in the block and reports any number beyond the file's last line.
- **The README matches the tool.** It listed five tools and described the old agent prompt; its sample run showed 1.3.0 and 19 vendored files; `--force` was said to replace a block it keeps when people edited it; `--discard-edits` and most `decide` options were missing.
- **Setup's "What you have now" says where decisions are kept.** Every install includes the Decisions section, and the summary left it out.

### Added

- **`briefing` compares the toolset with what package.json records.** When package.json or the npm lockfile has a different naso-dev than `.naso/tooling/`, or a caret range in a repository that pins exact versions, it notes it with the exact install command, so a repository set up before 1.5.1 gets the pinning fix too. `refresh` says the same after it runs.
- **`review` lists the rows your docs mark Decided that no record cites yet**: rows of any Markdown table with a Status column, with file and line, so the agent proposes them instead of searching every doc. A row a record already cites as its source is left out.
- **`review` names build, test and dependency tool config** among the repository's rule files: Renovate, Dependabot, `.npmrc`, `.nvmrc`, `eas.json`, and Metro, Babel, Jest, Vitest, Vite, Next and other `*.config.*` files.

## 1.5.1

### Fixed

- **`decide` and `decisions sync` keep what a person wrote on the decisions line.** They rewrote the whole line saying where the list is, which deleted any sentence a reviewer had added after it. Now only NASO's sentence moves, and `briefing` accepts text after it.
- **`refresh` moves both version stamps.** `briefing refresh` updated `<!-- version: -->` but left "Generated by NASO 1.4.0" in the header, so the block contradicted itself.
- **Source Map descriptions are whole sentences.** They were cut at 117 characters, mid-word ("React Query c…"). Quoted precedence lines are no longer cut mid-word either.
- **`<placeholders>` in a decision survive Markdown.** `decide` puts a bare `<type>` in a code span, so GitLab and GitHub no longer hide it as an HTML tag.
- **An older decisions list becomes Prettier-clean on the next sync.** A list written by 1.3.x had no blank lines around its markers; `decisions sync` now adds them.
- **Hand-written decision records are read as written.** `**Status:** proposed` (the colon inside the bold) and a `## Sources` section are read, so the audit stops reporting "no source" for a record that has one.
- **naso-dev is pinned where the repository pins.** With `save-exact` in `.npmrc`, a Renovate config that pins, or only exact versions in `package.json`, setup records `1.5.1`, not `^1.5.1`.
- **`.naso/` gets its own comment in `.prettierignore`**, instead of landing under whatever comment the team's last section had.
- **The header no longer promises what the check does not test.** It says every count was counted when the block was written, and that `briefing` re-checks paths and the claims it can test, not counts.

### Added

- **An existing `.dockerignore` gets `.naso/`**, so `COPY . .` does not put the toolset in the team's image.
- **Scripts that never exit are named** next to the commands that rewrite files: dev servers and watchers (`expo start`, `nest start --watch`, `next dev`, `vite`, `nodemon`, …), so an agent does not run one as a check.
- **`review` says when ESLint will lint the vendored toolset.** A flat ESLint config that does not ignore `.naso/` reports each vendored file's `eslint-disable` header as unused; the prompt has the agent report the one-line fix instead of editing the toolset.
- **The prompt tells the agent not to write decision counts or ids into the block**, since the next `decide` makes them stale.

## 1.5.0

### Added

- **`naso-dev review` prints the agent prompt at any time, built from the repository as it is now.** Setup ends with the same prompt. It names the rule files this repository actually has (contributing guides, CODEOWNERS, review templates, CI, hooks, lint and format config, docs), never a `.env` file. It says whether the block was reviewed before, and on a second review asks the agent to check what changed since then instead of starting over. It lists what `briefing` and `decisions audit` report today, and any version gap.
- **The prompt asks for a full audit, not only additions.** For each line of the block the agent keeps, corrects or removes it. It removes lines that are wrong, repeat a linked file, or would not change what an agent does. It cites file and line numbers, quotes whole sentences, and leaves the git index exactly as it found it. It also checks NASO's other files against the repository's own check-only format and lint commands and says how to fix each failure. The report ends with "What NASO gives this repository": counted, specific, and only what the run verified.
- **AGENTS.md tells every session to keep decisions and the block current.** Before asking the person a question, an agent checks the decisions list, including the options turned down. It records a decision made in the session before the session ends. A new "When This Block Is Wrong" section tells it to correct a line the repository contradicts, citing the file, instead of working around it.
- **`decide --considered "<option> — <why not>"`**, repeatable, writes a "Considered and not chosen" section, so a later session does not offer a turned-down option again.
- **`briefing` notes a version gap** between the block's stamp, `.naso/tooling/` and the running command, with the command that closes it. It is a note, not a failure, so a teammate's upgrade never blocks a commit.

### Fixed

- **`decide --why "<reason>"` records the reason.** `--why` was parsed as setup's switch, so the reason became the target directory: NASO created a folder named after the sentence, with a second decisions tree inside it, and numbered the record 0001 again. `decide` now also refuses a target directory that does not exist.
- **`decide` says it once.** A title that is already recorded is refused, naming the record, unless the new record supersedes it.
- **"No decision is recorded yet" no longer outlives the first decision.** `decide` and `decisions` rewrite that one line in AGENTS.md when the list appears, and the change does not count as an edit to the block. `briefing` reports the line as WRONG when a record was added by hand. The line no longer counts as describing `docs/`, so the first decision still earns the area its own line.

## 1.4.0

### Fixed

- **A regenerate never wipes a reviewed NASO block.** Each block now carries a digest of what NASO wrote. When the block no longer matches, because people corrected it, setup keeps it, `--force` keeps it, `briefing create --force` keeps it, and the "Replace it?" question is not asked. Only `--discard-edits` replaces an edited block, and the old block is saved under `.naso/backups/` first. A block written by 1.3.x or earlier has no digest and counts as edited, so upgrading cannot overwrite corrections. Re-stamping by `refresh` and the area lines the hook appends do not count as edits.
- **The entry point is what runs, not the first file alphabetically.** It is read from `nest-cli.json`, a Dockerfile `CMD` or `ENTRYPOINT`, then the `start:prod` and `start` scripts, and a compiled path such as `dist/main.js` is traced back to `src/main.ts`. The briefing says which file named it. With none of those, a filename guess now prefers `main` and `index` over `app`, which in a NestJS or Express service builds the app rather than starting it.
- **One `.mjs` config file no longer makes a project "ES modules".** `eslint.config.mjs` and other `*.config.mjs` files are not counted. A TypeScript project with no `"type"` field is described from tsconfig's `module`: `nodenext`, `node16` or `commonjs` compiles to CommonJS, and the briefing says so.
- **Commit subjects are counted by their exact form.** `chore(SCRUM-40): x` was counted as following `type: SCRUM-n: summary`, which inflated the count. The briefing now gives the exact count for the most common form, then the rest by form and how many have no type.
- **Source Map descriptions come from the right lines.** A folder-structure doc is read before an architecture doc. Tree diagrams (`├── config/   # …`) are read for the direct children of the source root. A table row is split into cells instead of turning its pipes into fragments, and a folder only mentioned in passing mid-sentence no longer lends that sentence as its description.
- **A git-ignored path is not reported as missing.** `src/gen/` is generated, so `briefing` counts it as verified and says how many were ignored. A path in another repository can be written as `repo:path` (for example `customer-changelog:changelog/customer/`) and is not checked; the MISSING report says so.

- **Setup leaves a CLAUDE.md that is someone else's.** When `.prettierignore` marks `CLAUDE.md` as kept as published, or `CODEOWNERS` gives it to an owner, setup does not append `@AGENTS.md`, even with `--track`. The plan and the result say who it belongs to and that Claude Code starts without the briefing until they add the line.
- **`decide` does not reuse a number another branch has.** It reads every local and remote branch's decisions folder and takes the next number above all of them, then says which numbers it skipped and on which branch. Two branches each writing 0002 no longer collide at merge.
- **The decisions list passes `prettier --check`.** `docs/decisions/README.md` has blank lines around every heading, list and marker, so a repository whose CI checks formatting does not fail on it.

### Added

- **`briefing` checks claims, not only paths.** A new WRONG section reports an entry point that `nest-cli.json`, a Dockerfile `CMD` or the start script contradicts, and a "Modules:" line that `package.json` `"type"` and tsconfig `module` contradict. Before, a block could name a real file as the entry point, call a CommonJS service ES modules, and still pass.
- **Files the repository says are not edited by hand.** A `.prettierignore` or `.eslintignore` comment such as "Generated by npm run openapi" or "kept as published" above a path puts that path in Boundaries, quoting the comment, with what to do instead.

## 1.3.1

### Fixed

- **The README's install command records naso-dev as a dev dependency.** Quick Start said `npx naso-dev`, which leaves the devDependencies step to a question that is easy to miss. It now says `npx naso-dev@latest --save-dev`, and the script example `npx naso-dev --yes --save-dev`, so naso-dev never ships in an app's production dependencies or build. The README also says plainly that `npm i naso-dev` only installs the package: it runs no setup and asks no questions.
- **The README shows what a run looks like.** A new "What you will see" section walks through a first run in four steps, with the terminal output of each: what NASO found, the questions, the plan, and what it wrote.

## 1.3.0

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
