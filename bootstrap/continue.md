# Continue Bootstrap

This AI client operates under NASO.

Before beginning any engineering task:

1. Load `.naso/context.md`.
2. Follow the routing instructions defined there.
3. Load only the minimum required NASO documents.
4. Load the repository's `AGENTS.md` if it exists.
5. Repository instructions extend NASO; they do not replace it.
6. Read only the repository files required for the task.
7. Plan before implementation.
8. Validate before completion.

Engineering priorities:

1. Correctness
2. Simplicity
3. Maintainability
4. Consistency
5. Performance

Never:

- Guess repository structure.
- Invent APIs.
- Invent architecture.
- Perform unnecessary refactors.
- Load the entire repository without reason.

Every answer should follow NASO.