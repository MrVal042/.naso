# NASO 10/10: Product & Functional Requirements Document (PRD/FRD)

## 1. Product Requirements (PRD)

### 1.1 Objective
Transform NASO from a passive set of Markdown guidelines into an active, automated developer operations engine. It must align human developers and AI assistants under the same execution standards while minimizing AI token usage, preventing architectural drift, and eliminating configuration duplication.

### 1.2 Target User Personas
1. **The Developer (Human)**: Needs instant feedback on code compliance and minimal friction during setup and commits.
2. **The AI Assistant (Agent)**: Needs clean, concise, relevant context maps instead of overwhelming raw repository directories.

### 1.3 Key Problems & Solutions
* **Problem**: AI context window inflation (token burnout).
  * **Solution**: A context assembler compiles task-specific type signatures and playbooks based on Git diffs.
* **Problem**: Stale guidelines (Wiki Rot).
  * **Solution**: The diagnostic script (`doctor.mjs`) automatically scans codebase structure to sync architectural rules.
* **Problem**: Tooling fragmentation (Cursor vs. Aider vs. Antigravity vs. CI).
  * **Solution**: A rules compiler translates central NASO rules into client-specific configurations.

---

## 2. Functional Requirements (FRD)

### 2.1 The Rules Compiler (`compile-rules.mjs`)
* **Inputs**: Files under `.naso/standards/*` and `.naso/architecture/*`.
* **Outputs**:
  - `.cursorrules` (Cursor syntax)
  - `.agents/AGENTS.md` (Antigravity syntax)
  - `.aider.conf.yml` (Aider syntax)
  - `.github/workflows/naso-validate.yml` (GitHub Actions runner check)
* **Functional Logic**:
  - Parse markdown headings and rules.
  - Inject them into the specific template formats.
  - Warn if standard guidelines are missing.

### 2.2 The Context Assembler (`assemble.mjs`)
* **Inputs**: Current Git diff (`git diff --name-only`), task description (optional).
* **Outputs**: A temporary context payload file `.naso/task_context.md`.
* **Functional Logic**:
  - Identify modified files.
  - Parse imports of modified files to map dependency paths.
  - Select relevant playbooks (e.g. `playbooks/bug-fix.md` if diff is in source; `new-feature.md` if adding a file).
  - Collect exact TypeScript interfaces or function signatures referenced, omitting full file implementations.

### 2.3 The Git-Hook Gatekeeper (`validate.mjs`)
* **Inputs**: Staged Git files (`git diff --cached --name-only`).
* **Outputs**: Console output and exit code (`0` on success, `1` on failure).
* **Functional Logic**:
  - Run Prettier checks only on staged files.
  - Run ESLint checks only on staged files.
  - Verify branch naming convention (e.g., `feature/*`, `bugfix/*`, `hotfix/*`).
  - Verify that changes do not import files across restricted architectural boundaries.

### 2.4 The Environment Diagnostician (`doctor.mjs`)
* **Inputs**: Active project directory scan.
* **Outputs**: Clean Markdown summary report to stdout.
* **Functional Logic**:
  - Detect project framework (Next.js, Node, React Native, Python, etc.).
  - Identify available package manager.
  - Check lockfile integrity.
  - Output summary: Active branch, uncommitted files, missing configs, status.

---

## 3. Boundary & Non-Functional Requirements
* **Zero Dependencies**: Must run on pure Node.js ESM. No third-party dependencies allowed.
* **Execution Speed**: Pre-commit validation must execute in `< 2.0 seconds` to prevent developer bypass.
* **Idempotency**: Bootstrapping and compiling configurations must not duplicate lines or crash if run multiple times.
