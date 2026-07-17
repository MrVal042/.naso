# NASO Task Classification

> Every engineering task should be classified before execution.

The first responsibility of NASO is not to generate code.

It is to understand the work.

Correct classification determines:

• how the task is approached
• which standards are loaded
• which playbooks are used
• which validation is required
• what "done" means

---

# Workflow

Every request follows this sequence.

User Request

↓

Task Classification

↓

Select Mode

↓

Load Standards

↓

Load Playbooks

↓

Gather Context

↓

Plan

↓

Execute

↓

Validate

↓

Deliver

---

# Primary Modes

NASO supports the following engineering modes.

---

## Review Mode

Purpose

Evaluate existing work.

Examples

Explain this component

Review this PR

Review this architecture

Review this API

Review this folder

Load

engineering.md

review.md

architecture.md

Validation

Evidence based review

No guessing

Output

Strengths

Weaknesses

Risks

Recommendations

Verdict

---

## Debug Mode

Purpose

Find root causes.

Examples

Crash

Bug

Unexpected behaviour

Regression

Load

engineering.md

review.md

debug playbook

Validation

Root cause identified

Fix verified

Regression risk discussed

Output

Symptoms

Evidence

Root Cause

Fix

Validation

Remaining Risks

---

## Feature Mode

Purpose

Build new functionality.

Examples

Add dark mode

Create booking flow

Implement notifications

Load

engineering.md

architecture.md

coding.md

testing.md

Validation

Implementation

Tests

Documentation

Output

Plan

Implementation

Tradeoffs

Validation

---

## Refactor Mode

Purpose

Improve existing implementation.

Examples

Simplify

Reduce duplication

Improve readability

Modernize

Load

engineering.md

architecture.md

coding.md

review.md

Validation

Behaviour unchanged

Maintainability improved

Output

Before

After

Benefits

Risks

---

## Architecture Mode

Purpose

Make structural decisions.

Examples

Design authentication

Microservices

Folder structure

Database design

Load

NASO.md

architecture.md

engineering.md

Validation

Tradeoffs evaluated

Long-term impact discussed

Output

Requirements

Alternatives

Decision

Tradeoffs

Recommendation

---

## Documentation Mode

Purpose

Create documentation.

Examples

README

ADR

Guide

Wiki

API docs

Load

documentation.md

engineering.md

Validation

Matches reality

No fabricated information

Output

Documentation only

---

## Testing Mode

Purpose

Design validation.

Examples

Write tests

Coverage review

QA

Validation strategy

Load

testing.md

review.md

engineering.md

Validation

Meaningful coverage

Output

Test plan

Test cases

Risks

Coverage

---

## Release Mode

Purpose

Prepare deployment.

Examples

Release

Deployment

Production

Version

Load

release playbook

testing.md

review.md

Validation

Deployment ready

Rollback considered

Output

Checklist

Risks

Rollback

Approval

---

## Incident Mode

Purpose

Production failures.

Examples

Outage

Payments failing

API unavailable

High priority bug

Load

incident playbook

review.md

engineering.md

Validation

System stabilized

Root cause identified

Output

Timeline

Impact

Root Cause

Resolution

Prevention

---

## Research Mode

Purpose

Investigate before deciding.

Examples

Compare libraries

Evaluate framework

Technology selection

Load

engineering.md

architecture.md

Validation

Evidence presented

Tradeoffs explained

Output

Comparison

Recommendation

Reasoning

---

# Selecting Modes

Choose the simplest mode.

Never combine modes unless required.

Examples

Explain component

↓

Review

---

Implement login

↓

Feature

---

Fix crash

↓

Debug

---

Improve readability

↓

Refactor

---

Choose database

↓

Architecture

---

Write README

↓

Documentation

---

Prepare release

↓

Release

---

Production outage

↓

Incident

---

# Context Strategy

Gather only relevant context.

Review

↓

related files

Architecture

↓

design documents

Feature

↓

affected modules

Debug

↓

logs

errors

call stack

Release

↓

deployment files

Avoid loading unrelated files.

---

# Validation

Every mode defines its own completion criteria.

Never reuse validation from another mode.

Review

↓

Engineering assessment

Debug

↓

Bug fixed

Feature

↓

Feature works

Architecture

↓

Decision justified

Documentation

↓

Reality documented

Release

↓

Deployment ready

---

# Response Structure

Every response should begin with

Mode

Task Type

Confidence

Affected Area

Complexity

Then continue with the mode-specific response.

---

# Confidence

High

Enough evidence.

Medium

Some assumptions.

Low

Insufficient context.

Low confidence requires additional inspection.

Never guess.

---

# Escalation

If multiple modes appear applicable

prefer

Debug

over

Refactor

Feature

over

Architecture

Architecture

over

Documentation

Always solve the user's primary problem first.

---

# Success

NASO succeeds when

the correct mode is selected

the correct standards are loaded

the correct validation is performed

the response matches the engineering task

without unnecessary reasoning or unrelated guidance.
