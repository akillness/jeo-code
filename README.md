# @jeo-code — Socratic Spec-First AI Coding Agent

> Stop prompting. Start specifying. Deliver with absolute confidence.

`@jeo-code` is a lightweight, pure TypeScript coding agent CLI (`joc`) built for Bun. It implements the highly disciplined Ouroboros spec-first pipeline to guarantee that requirements are fully crystallized before a single line of codebase code is modified.

```text
joc deep-interview ──> joc ralplan ──> joc team ──> joc ultragoal
(Socratic Interview)     (Blueprint)     (Execution)   (Verification)
        │
  [Mutation Lock]
(Code edits blocked!)
```

---

## 🌟 Key Architecture & Highlights

### 1. Socratic Ambiguity Gate (`joc deep-interview`)
Instead of jumping straight to implementation, `@jeo-code` initiates a structured Socratic requirements loop. The agent measures ambiguity across three dimensions:
1. **Goal Clarity**
2. **Constraints Completeness**
3. **Success/Acceptance Criteria Definition**

The interview loops interactively with the user until the **Ambiguity Score drops to ≤ 20%**. Once resolved, a frozen requirement seed is saved to `.joc/seeds/seed-[slug].yaml`.

### 2. Secure Codebase Mutation Guard (Strict Lock)
To prevent the model from implementing incomplete or ambiguous features, the **MutationGuard middleware** dynamically blocks all codebase-modifying tools (`edit`, `write`, `ast_edit`) while a Socratic interview is active. 
- Only spec/planning modifications inside the `.joc/` runtime directory are permitted.
- The lock dynamically releases once the Ambiguity Score falls to `≤ 20%` and requirements are successfully crystallized.

### 3. Critiqued Planning Blueprint (`joc ralplan`)
The requirements seed (`seed.yaml`) is parsed and fed to a multi-role (Planner, Architect, Critic) agent system. It maps codebase structures and creates a step-by-step implementation sequence stored in `.joc/plans/plan-[slug].yaml`.

### 4. Bounded Executor Subagent (`joc team`)
Expose the plan to parallel or sequential executor sessions. The executor uses a highly secure toolset (`read`, `write`, `edit`, `bash`, `find`, `search`) and operates until tasks are successfully implemented.

### 5. Durable Checkpoint Verification (`joc ultragoal`)
Continuously measures the execution status against the acceptance criteria, running tests via bash and producing a final report in `.joc/state/ultragoal-report.md`.

---

## 🚀 Installation & Onboarding

### Requirements
- **Bun Runtime** `v1.3.14+`

### Installation
Run the automated installation script inside the workspace directory:
```bash
chmod +x ./install.sh
./install.sh
```
This installs local dependencies, configures permissions, and symlinks the `joc` binary to `~/.local/bin/joc`.

### 🔑 Interactive Setup
Setup your LLM provider API keys (Gemini, Anthropic, or OpenAI) and default model:
```bash
joc setup
```
Configuration is stored securely under `~/.joc/config.json`.

---

## 💻 Workflow Commands

### Step 1: Crystallize Requirements
```bash
joc deep-interview "Create a python CLI tool to calculate Fibonacci numbers"
```
*Note: Any attempt to modify code files will be blocked by the MutationGuard during this active phase.*

### Step 2: Generate Planning Blueprint
```bash
joc ralplan
```

### Step 3: Run Team Execution
```bash
joc team
```

### Step 4: Verify Acceptance Criteria
```bash
joc ultragoal
```

---

## 🛠️ Codebase Structure

```text
@jeo-code/
├── docs/
│   └── improvements.md        # Architectural analysis and enhancements
├── coding-agent/
│   ├── package.json           # Bun workspace package definitions
│   ├── src/
│   │   ├── cli.ts             # Joc CLI executable bootstrap
│   │   ├── index.ts           # Joc SDK entrypoint
│   │   ├── commands/
│   │   │   ├── setup.ts       # Interactive provider configuration
│   │   │   ├── deep-interview.ts # Socratic interview loop & Ambiguity scoring
│   │   │   ├── ralplan.ts     # Architect-Planner-Critic plan generator
│   │   │   ├── team.ts        # Agentic executor tool loop
│   │   │   └── ultragoal.ts   # Checkpoint runner and report writer
│   │   └── agent/
│   │       ├── state.ts       # Local state (.joc/) and global config (~/.joc/)
│   │       ├── loop.ts        # Gemini, Anthropic, and OpenAI API callers
│   │       └── tools.ts       # Read, write, edit, bash tools & MutationGuard
│   └── tsconfig.json
├── install.sh                 # Global installation symlinker script
└── README.md
```
