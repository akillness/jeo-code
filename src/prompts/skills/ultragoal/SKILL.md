---
description: Verify acceptance criteria, write report.
command: jeo ultragoal
when: When tasks are implemented and you need a final, high-level verification and summary report.
---

# ultragoal

Verifies the implementation against the acceptance criteria specified in the plan.
Runs checks, tests, or validations to ensure correctness.
Generates a final completion report outlining the changes and verification evidence.

## Artifact gate (gajae-code 0.7.4 parity)

The completion report must be backed by concrete artifacts, not assertions:
- Cite the exact verification commands run and their observed result (e.g. test
  counts, `typecheck` clean, build exit code) — never claim "tests pass" without
  the command and its output.
- Reference each changed file by path, and tie it to the acceptance criterion it
  satisfies.
- If an acceptance criterion could not be verified (missing credential, service,
  or product decision), say so explicitly and mark it unresolved rather than
  implying success. A criterion with no supporting artifact is NOT met.
