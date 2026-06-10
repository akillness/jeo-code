<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  A focused coding-agent runner for interviews, reviewed plans, tmux-native execution, and durable verification.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

<p align="center">
  <img src="assets/character.png" alt="jeo-code character mascot" width="320" />
</p>

> [!IMPORTANT]
> jeo-code is currently in V2 (Level 2) evolution. Expect active development and verify outputs before relying on it for critical production work.

## What is jeo-code?

jeo-code (**joc**) is a pure-TypeScript coding-agent runner. It follows a rigorous **deep-interview -> ralplan -> ultragoal** workflow to ensure requirements are clarified and plans are critiqued before any code is mutated.

It is designed to be an external orchestrator that works beside your existing tools, providing structured planning, persistent evidence, and isolated worktree support.

## Install



The scoped package is also available as .

## Quick start










Inside a **joc** session, use the public workflow surface:






Add  only when coordinated tmux workers materially help.

## Core capabilities

- **Interview before guessing**:  turns vague requests into concrete requirements via .
- **Plan before mutation**:  reviews the approach before code changes.
- **Execute with evidence**:  tracks goals, revisions, checks, and completion evidence.
- **Self-Evolution**: Integrated  loop for continuous self-improvement and correction.
- **Interactive Visibility**: Real-time status dashboard and tmux-backed parallel execution.

## Workflow surface

jeo-code ships four default workflow skills:

| Skill | What it does |
| :--- | :--- |
| **deep-interview** | Clarifies ambiguous requirements before planning or code changes. |
| **ralplan** | Builds and critiques an implementation plan before mutation. |
| **ultragoal** | Tracks goals through execution, revision, verification, and evidence. |
| **team** | Coordinates tmux-backed workers for parallel execution. |

And four bundled role agents:

| Agent | What it does |
| :--- | :--- |
| **executor** | Bounded implementation, fixes, and refactors. |
| **architect** | Read-only architecture and code-review assessment. |
| **planner** | Read-only sequencing and acceptance criteria. |
| **critic** | Read-only plan critique and actionability review. |

## Core Engine & Hierarchy

jeo-code maintains a clear hierarchy between the **Core Engine (joc)** and the **Global Jeo-Code (gjc)** orchestrator:

- **joc (Core Engine)**: The minimal tool-use loop and agent runner. Refactored for modularity and visibility.
- **gjc (Guide/Global)**: The higher-level hierarchy for system-wide orchestration, session management, and multi-agent coordination.

## Configuration

Provider settings and retry budgets live in  (or ):



## Development

Install dependencies and run from source:




Run the CLI from source:



To compile a standalone binary:



## Documentation

See hierarchical  files in each directory for detailed component documentation.

- [Core Engine](src/agent/AGENTS.md)
- [AI Providers](src/ai/AGENTS.md)
- [CLI Runner](src/cli/AGENTS.md)

---
*V2 Evolution Update: 2026-06-11 (Level 2 Finalized)*
