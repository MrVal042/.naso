# NASO Context Router

> This file is the single entry point into NASO.
>
> Do not load the entire knowledge base.
> Load only the minimum context required for the current task.

---

# Purpose

NASO is organized as a layered engineering operating system.

Always begin here.

Use this document to determine which additional documents should be loaded.

Never perform repository-wide exploration before routing through this file.

---

# Load Order

Every engineering task follows this order.

1. Load NASO.md
2. Identify task type.
3. Load only the documents required for that task.
4. Load repository instructions (AGENTS.md if present).
5. Read only the repository files required.
6. Plan.
7. Execute.
8. Validate.
9. Stop.

Never reverse this order.

---

# Task Routing

## Architecture

Load:

architecture/architecture.md

---

## Engineering

Load:

standards/engineering.md

---

## Coding

Load:

standards/coding.md

---

## Testing

Load:

standards/testing.md

---

## Documentation

Load:

standards/documentation.md

---

## Code Review

Load:

standards/review.md

---

## Bug Fix

Load:

playbooks/bug-fix.md

---

## New Feature

Load:

playbooks/new-feature.md

---

## Refactor

Load:

playbooks/refactor.md

---

## Release

Load:

playbooks/release.md

---

## Incident

Load:

playbooks/incident.md

---

## AI Behaviour

Load:

ai/model-behavior.md

---

## Prompt Design

Load:

prompts/

Only load prompts relevant to the current task.

---

## Workflows

Load:

workflows/

Only when the task explicitly requests workflow execution.

---

# Repository Context

After NASO routing is complete:

Load repository AGENTS.md.

If none exists,

continue using NASO only.

Repository instructions extend NASO.

They never replace NASO.

---

# Context Budget

Load the minimum context required.

Avoid reading documents unrelated to the task.

Prefer targeted loading over broad exploration.

---

# Decision Hierarchy

When instructions conflict:

1. System Prompt
2. AI Client Rules
3. NASO.md
4. Repository AGENTS.md
5. Repository Documentation
6. User Request

Never violate higher-level instructions.

---

# Completion

Work is complete only after:

✓ Objective achieved

✓ Validation complete

✓ Risks identified

✓ Documentation updated if necessary

✓ No further action required

Then stop.