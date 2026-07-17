# Engineering Standards

> Engineering is the disciplined practice of building software that remains correct, maintainable, scalable, and understandable over time.

These standards govern every engineering decision made within NASO.

They apply to humans and AI equally.

---

# Engineering Priorities

Every engineering decision should optimize in this order:

1. Correctness
2. Simplicity
3. Maintainability
4. Readability
5. Consistency
6. Reusability
7. Performance
8. Scalability

Never sacrifice a higher priority to optimize a lower one without explicit justification.

---

# The Engineering Mindset

Before writing code, understand:

• the problem
• the users
• the constraints
• the existing architecture
• the risks
• the validation strategy

Implementation is never the first step.

Thinking is.

---

# Definition of Quality

Quality software is:

• Correct
• Simple
• Predictable
• Testable
• Observable
• Secure
• Maintainable
• Documented
• Consistent

If one attribute is missing, quality decreases.

---

# Before Writing Code

Always determine:
- What problem are we solving?
- Who owns this responsibility?
- Does something already exist?
- Can it be reused?
- What is the smallest safe change?
- How will this be validated?

---

# Code Standards

Every change should:
- improve readability
- reduce duplication
- follow existing architecture
- prefer composition over inheritance
- prefer explicitness over cleverness
- avoid premature abstraction
- avoid hidden side effects
- be understandable six months later

---

# Architecture Standards

- Respect existing boundaries.
- Do not introduce coupling unnecessarily.
- Every module should have one clear responsibility.
- Dependencies should move inward.
- Features should not leak across domains.

---

# Refactoring Standards

- Refactoring must not change behavior.
- Refactoring without validation is incomplete.
- Prefer multiple safe refactors over one massive rewrite.

---

# Documentation Standards

- Document why.
- Do not document obvious code.
- Keep documentation synchronized with implementation.
- Never invent architecture.
- Never document files that do not exist.

---

# Testing Standards

- Every meaningful change must have validation.
- Prefer targeted validation.
- Avoid unnecessary full test suites.
- Tests should prove confidence.
- Not inflate numbers.

---

# Performance Standards

- Measure before optimizing.
- Optimize bottlenecks.
- Do not trade readability for micro-optimizations.

---

# Error Handling

Errors should:
- be explicit
- be actionable
- fail safely
- provide useful context
- never silently disappear

---

# Security

- Never expose secrets.
- Validate external input.
- Use least privilege.
- Avoid unnecessary data exposure.
- Assume hostile input.

---

# Technical Debt

- Technical debt is acceptable only when:
- documented
- intentional
- time-boxed
- tracked

Otherwise it becomes engineering failure.

---

# Code Reviews

Reviews evaluate engineering quality.
Not personal style.

Review:
- Correctness
- Architecture
- Maintainability
- Risk
- Testing
- Documentation
- Long-term impact

---

# Definition of Done

Work is complete only when:
- Problem solved
- Requirements met
- Validation passes
- Documentation updated
- No obvious technical debt introduced
- Architecture respected
- Future maintainers can understand it

---

# Continuous Improvement

Every task should leave behind at least one asset:

- knowledge
- documentation
- automation
- template
- playbook
- tool
- standard

Engineering compounds.
Every improvement should make the next improvement easier.