# Contributing to NASO

Thanks for helping. This file is short on purpose — the rules are few, and all of
them exist because breaking one has cost somebody an afternoon.

## The one rule

**Every behavior change needs a test that fails before the fix.**

Not a test that passes. A test you have watched fail against the old code and pass
against the new. If you cannot make it fail, you do not yet know what your change
does, and neither does the reviewer.

```bash
# 1. Write the test. Run it. Watch it fail. Paste the failure into the PR.
npm test

# 2. Make the change. Run it again. Watch the same test pass.
npm test
```

A test that never failed proves nothing about the bug it claims to cover.

## Getting set up

```bash
git clone https://github.com/MrVal042/.naso.git && cd .naso
npm test
```

Node 20 or newer. That is the only requirement beyond git. There is no `npm install`
step: NASO has no dependencies, and the tests use `node:test`.

## Before you open a pull request

- `npm test` passes, all of it.
- One behavior change per commit, with a message that says what was false before.
- No unrelated reformatting. If you need to reformat, do it in its own commit.
- If you changed what a command prints, update `README.md` in the same commit.

## House style

The comments in this codebase explain **why**, not what. A comment that restates
the line below it is noise; a comment that explains the decision nobody would
otherwise guess is the most valuable thing in the file. Match that.

Comments carry real opinions. When something is deliberately done an unusual way,
the comment says so and says what goes wrong the other way. Keep those.

Write plainly. Short sentences. Say the thing that is true rather than the thing
that sounds reassuring.

## Things that will be rejected

- **A test that did not fail first.** See the one rule.
- **A dependency.** `npm i naso-dev` installs one package, and the vendored toolset
  runs from a pre-commit hook on a machine with no `node_modules`. Node's core
  modules cover colour (`tooling/ui.mjs`) and prompts (`tooling/prompt.mjs`); use
  them. A test asserts no vendored module imports a bare specifier.
- **Reading and printing a secret.** Credential-shaped files are reported by path,
  never by content. A warning that quoted the file would put the key in the
  terminal scrollback and in whatever the reader pastes it into.
- **A placeholder the checker cannot verify.** Every path the briefing claims must
  exist, every real area must be mentioned, and no `<placeholder>` may remain.
- **Breaking `AGENTS.md` outside the markers.** The NASO block lives between
  `<!-- naso:start -->` and `<!-- naso:end -->`. Everything outside those markers
  stays byte-identical, with or without `--force`.

## Reporting a bug

`npx naso-dev doctor <path>` prints the environment, the hook, the vendored copy
and the briefing state. Attach its output, plus the command you ran and what you
expected instead. Delete anything secret before sending it.

## Larger changes

Open an issue first. NASO writes files into other people's repositories and
installs a hook that runs on every commit; changes to what it writes and when are
not the kind of thing to discover in a pull request.