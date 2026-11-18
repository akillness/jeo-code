---
description: Socratic ambiguity gate; freezes a seed only when clarity is sufficient, with --auto for non-interactive clarification.
command: 'jeo deep-interview "<idea>"'
when: When an idea is vague and needs requirement gathering and refinement before planning.
---

# deep-interview

Initiates a Socratic dialogue to ask clarifying questions about a vague idea.
Scores the ambiguity of the proposal and iterates until it is under 20%.
Freezes a structured requirements seed only after concrete acceptance criteria exist.
Supports an --auto flag for non-interactive clarification without bypassing the ambiguity gate.

## Karpathy & Harness² Freeze Gate

- Stop before design or coding whenever multiple interpretations or contested tradeoffs remain; surface options explicitly instead of guessing silently.
- Freeze both the bounded scope and objective acceptance criteria in the seed so downstream planning (`ralplan`) and verification (`ultragoal`) evaluate against a fixed baseline.
