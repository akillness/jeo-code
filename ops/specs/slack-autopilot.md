# Spec: Slack Direct Request Flow & Autopilot Automation

## Goal
Implement a direct request flow for Slack (distinct from command-based flow) and automate 20+ cycles of autopilot evolution for .

## Improvement Points
1. **Slack Direct Request Flow**:
   - Detect direct messages or mentions that are not formatted as commands.
   - Route these requests through the same backend logic as commands.
   - Support "background bot" utilization where multiple bots can contribute to a single request context.

2. **Autopilot Evolution (20+ Cycles)**:
   - Automate the  loop.
   - Ensure  is used for code changes.
   - Use  for real-time monitoring and verification.
   - Record progress in  and .

## Methodology: ooo ralph
- **Spec**: This document.
- **Plan**: Generate a plan using .
- **Implement**: Apply changes to .
- **Verify**: Use  and .
- **Capture**: Snapshot state and update vault.
