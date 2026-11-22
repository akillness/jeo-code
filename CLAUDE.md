<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

<!-- JEO-WORKFLOWS:START -->
## Workflow rules
Every prompt: openspace route → rtk shell → semble search → jev (only after rtk and
semble, if a profile is enabled) → then by query: knowledge → second-brain vault,
code/memory → `.mex/`, semantic search → `zg query`, ontology → open-ontologies,
harness changes → `.harness2/`. Code graph/DB fallback: `jeox` (`.jeo/db/jeo.db`,
managed exclusively by `../jeo-code` — `jeo jeox who-calls|what-calls|where-defined|impact|query`,
MCP `tools.jeox.*`). Full rules: `.agents/rules/jeo-workflows.md` (global copy `~/.agents/rules/jeo-workflows.md`).
<!-- JEO-WORKFLOWS:END -->

<!-- mex-setup:start -->
MEX setup is not finished (0/9). Run `mex setup next --start` first and do what it prints; repeat until it says setup is complete.
<!-- mex-setup:end -->
