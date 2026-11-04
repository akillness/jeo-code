# jeo-code Constitution

## Principles
- **Spec-First**: Always clarify requirements before implementation.
- **Modular Self-Improvement**: Self-improvement features are for development only and must be detachable.
- **Agent Hierarchy**: `joc` is the Core Engine and ultimate authority. `gjc` (jeoclaw) acts as the expert Implementation Guide/Consultant that assists `joc` in its self-improvement and development.
- **Zero-Dependency Core**: Maintain Bun-native, zero-native-dependency architecture.

## Non-Negotiables
- `joc` self-improvement code must reside in `@dev` scoped directories or be guarded by `JOC_DEV_MODE`.
- All `gjc` implementations must pass `bun test` before being accepted by `joc`.
\n- **joc Sovereignty**: `joc` must maintain its status as the core platform. `gjc` provides the technical labor and guidance for `joc` to expand its own capabilities.