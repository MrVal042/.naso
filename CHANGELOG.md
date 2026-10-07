# Changelog

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

### Changed

- **Plan first, then one question.** `npx naso-dev` asks what the plan depends on, lists every file it would write with its line count and the hook decision, then asks: *Write these files and install the hook?* — accept, reject, or exclude an area. Reject reads the repository again; a second reject offers exit or a support report, and both leave the repository byte-identical. `naso-dev setup` runs this flow.
- **No terminal and no `--yes` exits 2**, naming `--yes` and `--dry-run`. `--dry-run` exits 0.
- **`FORCE_COLOR` is honoured.** Precedence: `--no-color`, `NO_COLOR`, `FORCE_COLOR` or `--color`, then whether stdout is a terminal.
- The opening screen uses one label column.

## Planned for 1.2.0

- A scope-strictness question during setup.
- A never-touch-paths question during setup.
- A target-agents question during setup.
- Refresh mode: show a diff of what would change and ask, instead of reporting.
- Windows shell handling (spawning `.cmd` package-manager shims). Windows is not supported until then.
