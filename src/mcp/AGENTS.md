<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# mcp

## Purpose
Model Context Protocol stdio/SSE server integration. It enables external LLM IDEs (e.g. Cursor, Claude Desktop) to invoke `joc` tools and workflows.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Exports public MCP server entry points |
| `server.ts` | Configures and launches the MCP protocol server |
| `tools.ts` | Registers the Ouroboros pipeline tools (`ouroboros_execute_seed`, `session_status`, etc.) |
| `protocol.ts` | Message frame serialization and transport handlers |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- To enable workspace pipeline tools via MCP, ensure the environment flag `JOC_MCP_PIPELINE=1` is set.

## Dependencies

### Internal
- `src/agent/` (drives agent loops and reads/saves workflow state files)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
