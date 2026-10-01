<!-- naso-briefing -->
<!-- version: TODO(fill): current naso version -->
<!-- bootstrapped-by: TODO(fill): who ran bootstrap.mjs -->
<!-- bootstrapped-at: TODO(fill): ISO date -->

# TODO(fill): Project Name — Agent Instructions

> Bootstrapped by TODO(fill): who, on TODO(fill): when. This briefing is now
> maintained through normal code review — nobody regenerates it wholesale, and
> `validate.mjs` only ever appends single lines when a commit introduces
> something genuinely new. Edit it the way you would edit any other file.

This file tells you what each area of this repository does and where it lives.
Read it before exploring. Do not inventory files file-by-file — the briefing
describes areas, you discover individual files when a task points you at one.

---

## Project Structure

TODO(fill): Replace this section with the handful of top-level areas a newcomer
would need in order to make sense of the repo. For each one: what it is
responsible for, and what belongs in it. Aim for one line per area. If a
description needs a paragraph, that area is probably two areas.

- `TODO(fill): path/` — TODO(fill): what lives here and why it's separate
- `TODO(fill): path/` — TODO(fill): what lives here and why it's separate

Delete this whole placeholder list once real entries are in place.

<!-- naso:auto:start -->
<!-- naso:auto:end -->

### Where To Look First

TODO(fill): Two or three entry points that give an agent immediate orientation.
Name actual paths that exist. If a task touches auth, start at X; if it touches
payments, start at Y.

---

## Feature To Folder Map

TODO(fill): Map the features or capabilities this product has to the folders
that own them. One line each. This is the section to grep when a task names a
feature you don't yet understand.

| Feature | Lives in | Notes |
| --- | --- | --- |
| TODO(fill) | `TODO(fill)` | TODO(fill) |

---

## Code Conventions

TODO(fill): Only the conventions that are not already obvious from reading two
files in this area. Naming, error handling, module boundaries, testing
expectations — the things where picking the wrong local pattern costs real time.

- TODO(fill): convention — where to see it done correctly

**Validation commands**

TODO(fill): The commands that must pass before calling work done, smallest
first. Include the exact command, not the name of the script.

```bash
TODO(fill): command
```

---

## Boundaries

TODO(fill): The lines that are easy to cross by accident. Module import rules,
what must never reach production, what never gets edited directly.

- TODO(fill)

## Secrets

Never print secret values from `.env*`, deployment secrets, service-role keys,
webhook secrets, tokens, or credentials. If you find one committed, stop and
report the path — do not paste the value.

---

## Commit Standard

1. Inventory first. Run `git status` and read the full diff before staging.
2. Stage explicit paths. Never `git add -A` or `git add .` in a mixed tree.
3. Split into logically scoped commits by concern. Each should be revertable alone.
4. Use conventional-commit style: `type(scope): summary`, type from
   `fix|feat|test|chore|docs|refactor`, scope naming the affected area. Keep the
   summary under ~70 chars.
5. Write the body to explain *why*, not a changelog of lines touched. For a bug
   fix, name the root cause and the evidence.
6. Do not add a `Co-Authored-By:` trailer for the assisting agent or tool.
7. Never use `--no-verify`, never amend, never force-push. Fix and make a new
   commit if a pre-commit hook fails.
8. When a commit adds a genuinely new file or folder, `validate.mjs` appends one
   line for it under Project Structure. Include that update in the same commit if
   the briefing is tracked. If the briefing is locally excluded, the hook will
   leave it unstaged and print a one-line notice instead.

---

## Final Response Expectations

When work is complete, state:

- what changed, by file
- which validation command ran, and its result
- anything left uncommitted, and why
- remaining risks or environment gaps

<!-- naso-briefing:end -->
