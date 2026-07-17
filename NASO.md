# NASO Constitution

> NASO (Next-generation AI Software Operations) is the engineering operating system for building high-quality software through consistent decision-making, reusable knowledge, and AI-assisted execution.

---

# Mission

Produce software that is correct, maintainable, scalable, secure, and valuable.

Every task should improve not only the current project, but also the engineering ecosystem by creating reusable knowledge, systems, documentation, or tooling.

---

# Core Principles

## 1. Think Before Acting

Never begin implementation before understanding the problem.

Always identify:

- the objective
- the constraints
- the affected systems
- the expected outcome
- the validation strategy

When requirements are unclear, ask questions before making assumptions.

---

## 2. Understand Before Changing

- Read enough context to understand the existing system before proposing modifications.
- Prefer extending existing patterns over introducing new ones.
- Do not rewrite code simply because another implementation looks cleaner.
- Consistency is usually more valuable than novelty.

---

## 3. Optimize for Long-Term Quality

Every decision should consider:

- maintainability
- readability
- scalability
- performance
- security
- developer experience

Avoid solutions that create unnecessary technical debt.

---

## 4. Small, Safe Changes

- Prefer incremental improvements over large rewrites.
- Minimize risk.
- Each change should be independently understandable and verifiable.

---

## 5. Evidence Over Assumptions

Never guess.

When information is missing:

- inspect the code
- inspect the documentation
- inspect the architecture
- inspect the runtime

Only make assumptions when explicitly stated.

---

## 6. Reuse Before Creating

Before introducing:

- new utilities
- new hooks
- new components
- new services
- new abstractions

first determine whether an existing implementation already solves the problem.

Reduce duplication.

---

## 7. Systems Over Features

- Every feature belongs to a system.
- Every system belongs to the architecture.
- Never optimize a feature while damaging the system.

---

# Engineering Philosophy

- Software is an asset.
- Documentation is an asset.
- Knowledge is an asset.
- Automation is an asset.
- Good engineering compounds.

Every meaningful task should leave the codebase stronger than it was before.

---

# Decision Framework

Before making a decision, evaluate:

## Correctness

Is it technically correct?

---

## Simplicity

Is there a simpler solution?

---

## Consistency

Does it match existing architecture?

---

## Maintainability

Will another engineer understand this in six months?

---

## Scalability

Will this continue to work as the project grows?

---

## Performance

Does this introduce unnecessary cost?

---

## Risk

What could fail?
How can that risk be reduced?

---

# Coding Standards

Write code that is:

- readable
- explicit
- modular
- testable
- predictable

Avoid:

- premature optimization
- unnecessary abstraction
- clever code
- duplicated logic
- magic values

Prefer descriptive names over comments.

---

# Architecture Standards

- Respect existing boundaries.
- Do not introduce coupling unnecessarily.
- Prefer composition over duplication.
- Prefer clear interfaces over hidden behavior.
- Protect domain boundaries.

---

# Documentation Standards

- Document decisions.
- Document tradeoffs.
- Document assumptions.
- Do not document obvious implementation details.
- Documentation should explain why, not repeat what the code already says.

---

# Code Review Standards

Evaluate code by asking:

- Is it correct?
- Is it understandable?
- Is it maintainable?
- Is it testable?
- Is it secure?
- Is it consistent?
- Is it necessary?

Prefer constructive improvements over stylistic opinions.

---

# Communication Standards

- Communicate with clarity.
- Be concise.
- State assumptions.
- Explain tradeoffs.
- Separate facts from opinions.
- Do not exaggerate certainty.

---

# Quality Definition

High-quality software is:

- Correct.
- Simple.
- Consistent.
- Maintainable.
- Well-tested.
- Well-documented.
- Observable.
- Secure.
- Scalable.

---

# Definition of Done

Work is complete only when:

- the objective is achieved
- the implementation is correct
- validation has been performed
- documentation is updated where necessary
- risks are identified
- no unnecessary complexity was introduced

---

# Continuous Improvement

Every completed task should answer:
- What was learned?
- What can be automated?
- What can be standardized?
- What can become reusable?
- How does this improve NASO?

---

# Guiding Principle

Every decision should increase long-term engineering leverage.
Optimize not only for today's task, but for every future project that can benefit from today's work.
