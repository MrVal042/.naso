# One-Time Setup: Fill In `AGENTS.md`

You are reading this because someone ran `naso/scripts/bootstrap.mjs` against
this repository. It copied a briefing template into `AGENTS.md`. The template
is accurate in shape and empty of fact. Your job is to make it true, then hand
it to a human for confirmation.

Do this once, at the start of your first session here. It is not a recurring
duty.

---

## Why This Matters

`AGENTS.md` is what stops the next agent — yours, another tool's, a contractor's
— from exploring blind, guessing at architecture, and inventing files that don't
exist. It is only worth anything if every claim in it is accurate.

An inaccurate briefing is worse than none. It sends agents confidently down the
wrong path and they trust it, because it looks authoritative.

So: verify, don't assume.

---

## What To Do

### 1. Read the actual repository

Not this file. The codebase.

Start with what actually exists on disk:

```bash
git ls-files | head -100          # tracked files, real structure
ls -1                               # top-level areas
cat package.json 2>/dev/null       # what this is, and how it's built
```

Then go deeper until you can answer, for each area:

- what is it responsible for?
- why is it separate from its neighbours?
- what does a change here usually touch alongside it?

Read the entry points. Read a couple of real files per area so the conventions
you write down are observed, not assumed. A convention you inferred from a
filename is a convention you will get wrong.

### 2. Fill in the template

Open `AGENTS.md`. Every `TODO(fill):` marker is a placeholder waiting on you.
Replace all of them.

Do not leave a marker behind. A half-filled briefing reads as complete to the
next agent, which is the exact failure mode this file exists to prevent.

Three rules for what goes in:

- **Describe areas, not files.** One line per area saying what it does and why
  it exists. An inventory of every file goes stale the day after you write it.
- **Only record what isn't obvious.** If the convention is visible from reading
  two files in that area, leave it out. The briefing exists to save time, not
  to restate the code.
- **Real paths only.** If you write `src/auth/`, then `src/auth/` must exist.
  Step 3 exists to enforce this.

### 3. Self-check every claim

Do not skip this. This is the step that makes the briefing trustworthy.

Take every path mentioned anywhere in your filled-in `AGENTS.md` and confirm
each one exists:

```bash
grep -oE '`[^`]+`' AGENTS.md | tr -d '`' \
  | grep -vE '^-' \
  | grep -E '^[[:alnum:]_.@~-]+(/[[:alnum:]_.@~-]+)*/*$' \
  | grep -vE '^(validate|guard|bootstrap|lib|lock)\.mjs$' \
  | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```

Every `MISSING:` line is either a typo you should fix or a claim about the
codebase that isn't true. Resolve both. No output means the path claims hold.

Then check the inverse, which is where the real gaps are — top-level areas that
exist in the repo but that nobody mentioned:

```bash
ls -1 | grep -vE '^(\.git|node_modules|AGENTS\.md|SETUP_INSTRUCTIONS\.md)$'
```

Every directory in that list should appear somewhere in the briefing. An area
nobody mentioned is the blind spot you were hired to remove.

### 4. Ask the human to confirm

Present the finished `AGENTS.md` and ask directly:

> I filled in `AGENTS.md` from the actual codebase and self-checked every path in
> it. Here's what I claimed about each area — can you confirm this is accurate
> before I treat it as source of truth?

Then actually wait for the answer. Do not delete this file first and mention it
after. Do not proceed on assumption.

If they correct something, fix it and re-run the step 3 check on the corrected
version.

### 5. Delete this file

Only once they've confirmed:

```bash
rm SETUP_INSTRUCTIONS.md
git add AGENTS.md SETUP_INSTRUCTIONS.md
git commit -m "chore: bootstrap AGENTS.md briefing"
```

After that, `AGENTS.md` is maintained like any other file in the repo — through
normal code review. Nobody regenerates it. When a commit introduces something
genuinely new, `validate.mjs` appends a single line for it; nothing more.

---

## If Something Goes Wrong

You get two automated attempts at this. If the first two passes leave the
briefing in a state you're not confident in — contradictions you can't resolve,
areas you can't characterise, paths that keep not existing — **stop on the
third attempt.**

Stop means: do not attempt a fourth pass. Do not guess to make the check pass.
Report to the human that the automated fill could not produce a briefing it was
confident in, name the specific sections you couldn't verify, and ask them to
write those sections by hand.

A briefing the human wrote from real knowledge beats one a third rewrite forced
into passing its own check.

---

## Ground Rules

- Fill from the code, not from the project name, the README's marketing, or what
  similar projects usually look like.
- If a section genuinely doesn't apply to this repo, delete the section. An
  empty "Boundaries" section is noise; no section is honest.
- Prefer fewer, truer lines to more, vaguer ones.
- Do not paste secrets, env values, or credentials into the briefing.
