ADR-0002

Title

NASO scripting favors project-specific generation over generic parsing or analysis, and never writes tracked files into a repository it does not own.

Status

Accepted

Context

The original scripting PRD specified a Rules Compiler that parses Markdown
standards into per-tool config files, and a Context Assembler that resolves
cross-file imports to build task context automatically.

Patonabl's existing `tooling/scripts/codebase-brief.mjs`,
`codebase-changed.mjs`, and `codebase-guard.mjs` already implement the same
goals — briefing an agent on what changed and guarding against mistakes — by
hardcoding real knowledge of Patonabl's own structure, not by parsing or
resolving anything generically.

NASO's own architecture standard already states the same conclusion:
"Copying ten simple lines is often better than creating a reusable
abstraction used once."

NASO is used by one operator across many repositories, some of which are
client or contract work the operator does not own.

Decision

Reject generic Markdown-rule parsing and generic cross-language import
resolution. Prefer:

- A bootstrap linker that places already-authored, human-reviewed content
  (`bootstrap/<tool>.md`) at the paths each tool expects, over a compiler
  that derives that content from prose at runtime.
- No context assembler. Rely on `context.md`'s existing routing model and
  the AI agent's own file-exploration tools.
- A warn-only, stack-agnostic guard script, generalized from Patonabl's
  validated `codebase-guard.mjs` pattern, instead of project-specific logic
  reinvented per repository.
- Every script defaults to leaving no tracked trace in a repository the
  operator does not own. Generated artifacts go to `.git/info/exclude`
  unless the operator opts in.

Consequences

Less code to maintain. No parser to keep in sync with how standards docs are
actually written. No import resolver to break on new languages or bundler
configurations.

Some manual work remains: placing bootstrap content for a new AI tool means
writing that tool's `bootstrap/<tool>.md` by hand, not generating it.

NASO stays safe to run against repositories the operator does not control.

Project-specific tools like Patonabl's remain the better choice inside their
own repository. NASO does not try to replace them — it fills the gap for
every repository that does not have that level of investment yet.
