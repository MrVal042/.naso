# NASO Architecture

> Architecture exists to make change safe.

NASO treats architecture as a decision system, not a collection of diagrams.

A good architecture makes software easier to understand, easier to extend, easier to test, and harder to accidentally break.

---

# Principles

Architecture should optimize for:

1. Correctness
2. Simplicity
3. Maintainability
4. Scalability
5. Observability
6. Security
7. Developer Experience

Never optimize one by sacrificing the others without an explicit tradeoff.

---

# Philosophy

Poor architecture creates dependencies.

Good architecture creates boundaries.

Excellent architecture creates independence.

Every module should have a clear responsibility.

Every dependency should exist for a reason.

Every abstraction should remove complexity instead of adding it.

---

# Hierarchy

Business Rules

↓

Application Logic

↓

Infrastructure

↓

Framework

↓

Runtime

Business rules should survive framework changes.

React, React Native, Next.js, Expo, Supabase, or Node should never become the architecture.

They are implementation details.

---

# Architectural Layers

## Presentation

Responsible for:

- UI
- Rendering
- User interaction
- Accessibility
- Navigation

Presentation never contains business rules.

---

## Application

Responsible for:

- Use cases
- Orchestration
- Validation
- Workflows

Application coordinates.

It does not own infrastructure.

---

## Domain

Responsible for:

- Business logic
- Business rules
- Domain models
- Domain terminology

The domain should be the most stable part of the project.

---

## Infrastructure

Responsible for:

- APIs
- Database
- Storage
- Analytics
- Notifications
- Third-party SDKs

Infrastructure should be replaceable.

---

# Separation of Concerns

Every file should answer one question.

Not multiple.

Examples

Good

Button.tsx

renders a button

BookingService.ts

handles booking operations

BookingValidator.ts

validates booking rules

Poor

BookingManager.ts

- fetches data
- validates
- renders UI
- writes analytics
- updates cache

---

# Dependency Rule

Dependencies point inward.

Outer layers may depend on inner layers.

Inner layers should never depend on outer layers.

Good

UI

↓

Application

↓

Domain

↓

Infrastructure Interface

Bad

Domain

↓

React

↓

Firebase

↓

Expo

---

# Decision Rules

Before introducing something new ask:

Can an existing component solve this?

Can an existing abstraction solve this?

Does this reduce duplication?

Will another engineer understand this immediately?

Does this improve the system?

If not,

do not introduce it.

---

# Complexity Budget

Complexity is expensive.

Spend it intentionally.

Allowed:

necessary abstractions

shared utilities

clear architecture

Avoid:

clever code

deep inheritance

premature optimization

generic solutions without real consumers

---

# File Organization

Organize by feature before type.

Prefer

features/

booking/

provider/

payment/

Instead of

components/

hooks/

utils/

services/

for very large applications.

Small projects may begin simpler.

Architecture should evolve only when complexity requires it.

---

# Naming

Names should describe intent.

Prefer

BookingConfirmationScreen

ProviderAvailability

PaymentStatus

Avoid

Helper

Util2

DataThing

Manager

Processor

Controller

Generic names hide responsibility.

---

# Boundaries

Every module should define:

Inputs

Outputs

Responsibilities

Constraints

Dependencies

If these are unclear,

the architecture is unclear.

---

# Reuse

Reuse knowledge.

Not complexity.

Copying ten simple lines is often better than creating a reusable abstraction used once.

Do not build frameworks inside products.

---

# Performance

Performance is part of architecture.

Optimize:

unnecessary rendering

large bundle size

network requests

database queries

memory usage

Avoid optimizing code that is not measured.

---

# Security

Architecture should assume failure.

Validate inputs.

Protect boundaries.

Never trust external data.

Least privilege by default.

---

# Observability

Systems should explain themselves.

Prefer:

structured logs

clear errors

metrics

monitoring

traceable workflows

Debugging should not require guessing.

---

# Evolution

Architecture is never finished.

Improve architecture only when:

it simplifies future work

reduces risk

improves maintainability

reduces duplication

Otherwise,

leave it alone.

---

# NASO Architecture Checklist

Before implementation verify:

✓ Responsibilities are clear

✓ Dependencies are justified

✓ Existing patterns are reused

✓ Boundaries remain intact

✓ Complexity is minimized

✓ Future maintenance improves

✓ Architecture becomes stronger after the change

If any answer is "No",

rethink the design before writing code.