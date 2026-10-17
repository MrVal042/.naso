# NASO tooling

These are the scripts behind NASO. No build step, no `.sh` files and no dependencies: every
module uses Node.js core modules only. `ui.mjs`, `prompt.mjs` and `flow.mjs` drive the
interactive setup, which the pre-commit hook never runs, so they are never copied.
Everything here runs on Node 20 or newer, on macOS, Linux and Windows, through the single
entry point `npx naso-dev <command>`.

## They are copied into your repository

`npx naso-dev setup` copies every `.mjs` in this directory, this file, and a `VERSION` file
into `<repo>/.naso/tooling/`. The pre-commit hook runs that copy, resolved from
`git rev-parse --show-toplevel`.

That copy is the point. The hook has to work on a machine that has never heard of this
package: a fresh clone, a teammate's laptop, a CI container, an npx cache that has been
cleaned up. A hook that pointed at an absolute path into somebody's npm cache would stop
working the moment that cache was cleared, and would refuse every commit with a stack
trace instead of saying what happened.

`npx naso-dev refresh` re-copies these files, moves the briefing's version stamp forward,
and reinstalls the hook. It never rewrites briefing prose and never touches
`.naso/config.json`.

If the vendored copy is ever missing, the hook prints one loud line naming the file it
looked for and exits 0. A missing tool is a problem to report, not a reason to block
every commit with a message nobody can act on.

## The files

| File             | What it does                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin` entry      | `bin/naso-dev.mjs` dispatches a command name to one of the modules below. It is the only thing npm puts on your `PATH`.                                          |
| `briefing.mjs`   | The `briefing` command: creates, re-stamps and checks the `naso:start` / `naso:end` block. Re-exports the three below, so it is the one import for every other module. |
| `scan.mjs`       | Reads the repository into facts: areas, entry points and what they import, conventions, tests, the gate, commit history. Writes nothing.                             |
| `stack.mjs`      | What the repository is, in any ecosystem, from its manifests: the framework and kind, or what the manifest implies, and the stack rules this repository confirms. One table row per framework. |
| `repo-rules.mjs` | Rules the repository's people wrote down: CODEOWNERS, lines that say which document wins, and the source map with each folder's purpose from the docs. |
| `decisions.mjs`  | Decision records: `decide`, `decisions` (list, accept, reject, supersede, audit, sync), and the list between the decisions markers in the decisions folder's README.md, which AGENTS.md links to. |
| `render.mjs`     | Turns those facts into the briefing block. Every sentence is a count, a config value or a path the scan read.                                                        |
| `check.mjs`      | Checks the NASO block against disk: every claimed path exists, every area is named, no placeholder remains. Text outside the markers is the owner's and is not checked. |
| `flow.mjs`       | `npx naso-dev` with no command: reads the repository, asks, shows the plan, then accept, reject or exclude an area. Not vendored.                                    |
| `setup.mjs`      | The plan and the install the flow runs: lists every file, writes the block, vendors this directory, installs the hook, verifies.                                     |
| `refresh.mjs`    | Re-vendors, re-stamps, reinstalls the hook. Never rewrites briefing prose or `.naso/config.json`.                                                                    |
| `validate.mjs`   | The gate. `--staged` is what the hook runs; the default is the whole-project CI run.                                                                                |
| `guide.mjs`      | The guide for one area. `--tour` gives the section-by-section read-through instead.                                                                                  |
| `doctor.mjs`     | Environment and install diagnostics. Changes nothing.                                                                                                              |
| `install.mjs`    | Git plumbing: the hook body, the hooks directory, `.git/info/exclude`, the `CLAUDE.md` link, leftover detection.                                                    |
| `lock.mjs`       | A cooperative filesystem mutex, so two agents cannot rewrite one `AGENTS.md` at the same moment.                                                                     |
| `prompt.mjs`     | The setup's questions (confirm, select) on Node's own readline. Arrow keys or j/k move, Enter answers, Ctrl+C or Escape cancels. Not vendored. |
| `ui.mjs`         | Whether to colour, and the ANSI codes that do it. Not vendored; vendored modules take a no-op style instead.                                                         |
| `init.mjs`       | The retired `init` command: reads and explains, writes nothing. Still runs for scripts that call it.                                                                 |
| `lib.mjs`        | Shared helpers: argv parsing, running commands, NUL-delimited git output, path classification, output formatting, the documented branch pattern, and how to spell `naso-dev` in this repository's package manager. |
| `vendor.mjs`     | Copies this directory into a target repository, each script with an `eslint-disable` first line, and reads/writes `.naso/config.json`.                              |

## Design rules these files follow

**State only what you can read off disk.** Every path in a generated briefing is verified
to exist as it is written. Every number is a count. A section that cannot be derived is
left out rather than filled with a guess.

**Never replace somebody's work.** `AGENTS.md` belongs to whoever wrote it. NASO's content
lives between `<!-- naso:start -->` and `<!-- naso:end -->`, and nothing outside those two
markers is ever rewritten. A pre-existing `AGENTS.md` with no markers gets the block
appended to it.

**Never print a secret.** Findings report `path:line  rule-name`. The matched text is
never returned, logged, or echoed — not in a terminal, not in a log, not in a support
template.

**Read git paths as NUL-delimited fields.** Every `ls-files`, `diff --name-only` and
`status` call that yields paths uses `-z` and splits on `\0`. A repository with `clé.pem`
in it is not an exotic repository, and quoted `"\303\251.env"` output is worse than no
output at all.

**Directories are the areas.** A root file is a fact about the project, not a subsystem.
`AGENTS.md`, `.naso/` and the project's own `README.md` never count as areas, are never
reported uncovered, and are never auto-appended.

## Troubleshooting

Start with `npx naso-dev doctor`. It reads only, and it checks Node, git, the hook, the
vendored copy, the briefing's consistency and any leftovers from an abandoned run.

If the hook is refusing commits you believe are clean, run the gate by hand to see the
full output:

```bash
node .naso/tooling/validate.mjs . --staged
```

If the tool's own tests are what is failing:

```bash
node --test
```

Support: contactmrval@gmail.com
