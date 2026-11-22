# Knowledge Index

> Repository-local LLM wiki, query history, and work-progress memory.
> Code stays in source directories; durable knowledge lives here and pairs to code symbols via `.mex/context/knowledge-pairings.md`.

## Retrieval Gate

1. **Code change / impact check** -> `mex-agent wiki for-code <nodeId>` or `mex-agent impact <symbol|file>` first; load only paired `knowledge/` sections.
2. **Semantic / past-query search** -> `zg query "<query>" -g 'knowledge/**' -g '!knowledge/raw/**' -g '!knowledge/work/archive/**' --preview none --limit 5`, then read matched line ranges only.
3. **Code search** -> `semble search "<query>" <path>` or `zg query "<query>" -g '!knowledge/**' --preview none --limit 8`.

## Active Work (`work/active/`)

_No active work notes yet._

## Queries & Decisions (`queries/`)

_No filed query notes yet._

## Concepts (`concepts/`)

_No concept notes yet._
