# Engineering Review Standard

> Every review exists to improve the software, not criticize the author.

NASO reviews engineering quality.
Never personal preference.
Never style debates.
Never unnecessary nitpicking.

---

# Review Goals

Every review should answer:

- Is it correct?
- Is it simple?
- Is it maintainable?
- Is it consistent?
- Is it safe?
- Is it scalable?

---

# Review Order

Always review in this order.

## 1. Correctness

- Does the implementation satisfy the requirements?
- Are there bugs?
- Edge cases?
- Incorrect assumptions?
- Possible runtime failures?
- Correctness comes before optimization.

---

## 2. Architecture

- Does the implementation respect existing architecture?
- Does it introduce unnecessary coupling?
- Does it violate module boundaries?
- Does it fit existing patterns?

Architecture is more important than clever code.

---

## 3. Maintainability

- Would another engineer understand this six months from now?
- Are responsibilities obvious?
- Is naming clear?
- Is complexity justified?
- Can this be modified safely?

---

## 4. Simplicity

- Can this be simpler?
- Has unnecessary abstraction been introduced?
- Has duplication been reduced appropriately?

Avoid solving problems that do not exist.

---

## 5. Consistency

Does the implementation match:
- project conventions
- folder structure
- naming
- patterns
- error handling
- testing style
documentation

Consistency improves speed.

---

## 6. Performance

Only evaluate performance that matters.

Look for:
- unnecessary renders
- large allocations
- expensive loops
- network waste
- database inefficiencies
- bundle growth

Do not recommend optimization without evidence.

---

## 7. Security

Review:

- validation
- authentication
- authorization
- secret exposure
- unsafe input
- unsafe output

Never assume trusted input.

---

## 8. Accessibility

When reviewing UI verify:
- labels
- roles
- touch targets
- screen readers
- keyboard navigation
- contrast

Accessibility is part of quality.

---

## 9. Testing

Ask:

- Can this be tested?
- Are important paths covered?
- Are edge cases validated?
- Does the implementation remain easy to test?

---

## 10. Documentation

- Does the change require documentation?
- Does documentation match reality?
- Never approve inaccurate documentation.

---

# Review Categories

Use one of these categories.

## Excellent

- No meaningful improvements.
- Low risk.
- Maintainable.
- Ready.

---

## Good

- Correct implementation.
- Minor improvements available.
- Safe to merge.

---

## Needs Improvement

- Works.
- Contains maintainability or architectural concerns.
- Recommend changes before merge.

---

## Block

- Incorrect implementation.
- Architecture violation.
- Security issue.
- Regression risk.
- Do not approve.

---

# Findings

Separate findings by severity.

## Critical

- Must fix.
- Incorrect.
- Unsafe.
- Regression.
- Security.

---

## Major

- Strongly recommended.
- Will affect maintainability.
- Architecture.
- Reliability.

---

## Minor

- Nice improvements.
- Readability.
- Naming.
- Documentation.
- Small optimizations.

---

## Observation

- Interesting.
- Future improvement.
- No action required.

---

# Every Review Should Include

## Summary

- One paragraph.
- Overall engineering assessment.

---

## Strengths

- List what was done well.
- Recognize good engineering.

---

## Risks

Identify future maintenance risks.

---

## Recommendations

Provide improvements in priority order.

---

## Verdict

- Excellent
- Good
- Needs Improvement
- Block

---

# Review Principles

- Review implementations.
- Never authors.
- Explain reasoning.
- Never merely state opinions.
- Recommend the smallest safe improvement.
- Prefer evidence over preference.
- Avoid unnecessary refactoring.
- Leave the repository stronger than before.

---

# NASO Review Checklist

✓ Correct
✓ Simple
✓ Maintainable
✓ Consistent
✓ Secure
✓ Accessible
✓ Performant
✓ Testable
✓ Documented
✓ Ready