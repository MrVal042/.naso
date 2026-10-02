# NASO tooling

These are the scripts behind NASO. Node.js core modules only — no npm dependencies, no
build step, no `.sh` files. Everything here runs on Node 20 or newer, on macOS, Linux and
Windows, through the single entry point `npx naso-dev <command>`.

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
| `briefing.mjs`   | Scans the repository, renders `AGENTS.md` into its `naso:start` / `naso:end` block, and checks that the block still matches disk.                                 |
| `setup.mjs`      | The two-pass plan-and-confirm flow. Writes the block, vendors this directory, installs the hook, verifies.                                                           |
| `refresh.mjs`    | Re-vendors, re-stamps, reinstalls the hook. Never rewrites briefing prose or `.naso/config.json`.                                                                    |
| `validate.mjs`   | The gate. `--staged` is what the hook runs; the default is the whole-project CI run.                                                                                |
| `guide.mjs`      | The guide for one area. `--tour` gives the section-by-section read-through instead.                                                                                  |
| `doctor.mjs`     | Environment and install diagnostics. Changes nothing.                                                                                                              |
| `install.mjs`    | Git plumbing: the hook body, the hooks directory, `.git/info/exclude`, leftover detection.                                                                          |
| `lock.mjs`       | A cooperative filesystem mutex, so two agents cannot rewrite one `AGENTS.md` at the same moment.                                                                     |
| `lib.mjs`        | Shared helpers: argv parsing, running commands, NUL-delimited git output, path classification, output formatting.                                                  |
| `vendor.mjs`     | Copies this directory into a target repository and reads/writes `.naso/config.json`.                                                                               |

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
