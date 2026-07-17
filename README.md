# NASO

> **Next-generation AI Software Operations**
>
> Build software that compounds.

---

# What is NASO?

NASO is an engineering operating system for humans and AI.

It provides a single source of truth for how software is designed, built, reviewed, documented, validated, and improved.

Instead of treating every project as a fresh start, NASO captures reusable engineering knowledge so that every project becomes easier to build than the last.

The objective is simple:

> Every task should improve the software, the engineering system, and the people building it.

---

# Why NASO Exists

Modern software development suffers from inconsistency.

Different projects adopt different conventions.

Different AI assistants produce different results.

Documentation drifts.

Architecture erodes.

Knowledge disappears.

NASO solves this by creating one engineering system that can be applied across every repository.

Rather than rebuilding engineering processes for every project, repositories inherit a shared operating model.

---

# Philosophy

Software is not the product.

Software is an asset.

Engineering is not writing code.

Engineering is designing systems that continue to create value long after they are written.

Every meaningful activity should produce at least one reusable asset.

Examples include:

- knowledge
- documentation
- automation
- tooling
- templates
- playbooks
- standards
- reusable code

This creates compounding engineering leverage.

---

# Core Principles

NASO is built on a small number of principles.

- Think before implementing.
- Understand before modifying.
- Prefer systems over features.
- Prefer simplicity over cleverness.
- Reuse before creating.
- Optimize for long-term maintainability.
- Make every change independently verifiable.
- Leave every repository better than you found it.

These principles are expanded inside **NASO.md**.

---

# Repository Structure

```
.naso/
├── NASO.md
├── README.md
├── roadmap.md
│
├── standards/
├── playbooks/
├── prompts/
├── workflows/
├── templates/
├── decisions/
├── knowledge/
├── tooling/
├── ai/
├── integrations/
├── models/
├── architecture/
├── docs/
├── examples/
└── archive/
```

Each directory exists for one purpose only.

Responsibility should never overlap.

---

# How Repositories Use NASO

Each repository consumes NASO rather than redefining engineering practices.

```
             NASO
                │
        Shared Standards
                │
      Shared Playbooks
                │
      Shared Prompt Library
                │
        Shared Workflows
                │
─────────────────────────────────
│        │        │             │
Repo A   Repo B   Repo C   Future Projects
```

Repositories remain independent while inheriting the same engineering standards.

This keeps quality consistent across an entire workspace.

---

# Humans and AI

NASO is designed for both engineers and AI assistants.

## Humans

Use NASO to:

- understand engineering standards
- follow proven workflows
- make consistent decisions
- reduce unnecessary complexity

## AI

Use NASO to:

- reason before coding
- follow repository standards
- avoid hallucinated architecture
- produce maintainable implementations
- justify engineering decisions

NASO defines **how AI thinks**, not merely what it generates.

---

# Engineering Workflow

Every task follows the same lifecycle.

```
Understand
      ↓
Research
      ↓
Plan
      ↓
Implement
      ↓
Validate
      ↓
Review
      ↓
Improve
```

Skipping a stage increases engineering risk.

---

# What's Inside

| Directory    | Purpose                         |
| ------------ | ------------------------------- |
| NASO.md      | AI constitution                 |
| roadmap.md   | Long-term direction             |
| standards    | Engineering rules               |
| playbooks    | Repeatable operating procedures |
| prompts      | Reusable prompts                |
| workflows    | End-to-end engineering flows    |
| templates    | Starting points for new work    |
| architecture | System design                   |
| decisions    | Engineering decision records    |
| knowledge    | Reusable domain knowledge       |
| tooling      | Developer automation            |
| ai           | AI configuration                |
| integrations | External systems                |
| models       | AI model strategy               |
| docs         | Supporting documentation        |
| examples     | Reference implementations       |
| archive      | Historical material             |

---

# Design Goals

NASO exists to make engineering:

- more predictable
- more consistent
- more maintainable
- more scalable
- more reusable
- less dependent on individual memory

The goal is not faster coding.

The goal is better engineering.

---

# Roadmap

NASO evolves in layers.

1. Foundation
2. Standards
3. Playbooks
4. Prompt Library
5. Workflows
6. Tooling
7. AI Integrations
8. Continuous Improvement

See **roadmap.md** for details.

---

# Relationship Between Documents

```
README.md
      │
Introduces NASO
      │
      ▼

NASO.md
Defines how AI thinks
      │
      ▼

Standards
Define engineering expectations
      │
      ▼

Playbooks
Define repeatable execution
      │
      ▼

Workflows
Connect everything together
```

Each document has a single responsibility.

---

# Guiding Principle

> Build software that compounds.

Every project should leave behind knowledge.

Every improvement should reduce future effort.

Every decision should increase engineering leverage.

That is NASO.
