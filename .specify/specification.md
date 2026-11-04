# Specification: joc-Centric Real-time Monitoring HUD

## Purpose
Enhance 'joc' (Sovereign Engine) with a real-time Monitoring HUD that tracks and visualizes the internal states of GJC-led consultations and implementations.

## User Stories
- As a user (제오임당), I want to see the real-time phase of 'joc' (Thinking -> Planning -> Executing -> Reporting -> Done).
- As a developer, I want 'joc' to automatically detect its own monolithic files (like engine.ts) and suggest modularization.
- As an orchestrator, I want to see the current 'Evolution Stage' (Primordial Cell to Singularity) based on tool progress.

## Requirements
1. **Real-time Phase HUD**: Implement  or similar to show .
2. **Autonomous Monitoring**: Periodic analysis of  and performance metrics.
3. **Evolution Tracking**: Map total steps to the 5 evolution stages defined in .
4. **Integration**: Connect  results to the TUI.

## Acceptance Criteria
-  (or equivalent) displays the 5-phase HUD.
- The Evolution Stage correctly reflects the current step ratio.
- Monolithic file warnings appear in the analysis report.
- 'joc run' (ooo run) mode shows real-time logs from sub-processes.
