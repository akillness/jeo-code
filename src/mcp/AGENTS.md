<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# mcp

## Purpose
Model Context Protocol (MCP) integration, allowing `jeo-code` to expose tools or consume context from external MCP servers.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Brief description of purpose |
| `protocol.ts` | Brief description of purpose |
| `server.ts` | MCP server implementation (if exposing tools) |
| `tools.ts` | Brief description of purpose |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Adhere strictly to the MCP specification.
- Handle JSON-RPC serialization and deserialization safely.

### Testing Requirements
- Unit test protocol messaging.

### Common Patterns
- Transport layer abstraction (stdio vs SSE).

## Dependencies

### Internal
- Connects external capabilities into `src/agent/tools.ts`.

### External
- Protocol dependencies if not implemented natively.

<!-- MANUAL: -->
