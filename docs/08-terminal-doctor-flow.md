# 08 — Terminal Install, Doctor, Provider/Model Flow

This note records the runnable `jeoc` terminal flow added after the gajae-code deep dive. It complements `05-provider-model-layer.md`, `06-agent-loop-tools.md`, and `07-cli-config-session.md` by making the install-to-agent path explicit and testable.

## Upstream concepts mirrored from gajae-code

| gajae-code concept | Upstream reference | jeo-code implementation |
| --- | --- | --- |
| Provider/model boundary | `packages/ai/src/stream.ts`, `packages/ai/src/providers/*`, `packages/ai/src/types.ts` | `src/provider.ts` exposes one `callProvider()` boundary for Gemini, Anthropic, OpenAI, and mock. |
| Model registry + dynamic availability | `packages/ai/src/models.ts`, `packages/ai/src/model-manager.ts`, `packages/ai/src/model-cache.ts` | `src/setup.ts` has a curated `KNOWN_MODELS` registry and `jeoc models --live` for Gemini key-scoped discovery. |
| Credential resolution | `packages/ai/src/auth-storage.ts`, auth broker/gateway files | `src/config.ts` resolves `.jeoc/config.json`, `~/.jeoc/config.json`, and provider env vars. API keys are masked in CLI output. |
| Terminal readiness check | GJC startup/auth diagnostics are distributed through CLI/config/auth layers | `jeoc doctor` gives one terminal command for runtime, provider, model, key source, optional live model listing, and optional provider probe. |

## Terminal flow

```sh
# from source
bun bin/jeoc.ts --version
bun bin/jeoc.ts setup --provider gemini --model gemini-2.5-flash
export GEMINI_API_KEY=...
bun bin/jeoc.ts doctor --live
bun bin/jeoc.ts agent "summarize this repo"

# hermetic/no-key path
bun bin/jeoc.ts setup --provider mock
bun bin/jeoc.ts doctor --probe
bun bin/jeoc.ts agent "hello" --provider mock
```

For a linked install:

```sh
bun link
jeoc --version
jeoc setup --provider gemini --model gemini-2.5-flash
jeoc doctor
jeoc models --provider gemini
jeoc agent "add a hello() to util.ts and run the tests"
```

## `jeoc doctor` contract

`jeoc doctor` is intentionally boring and non-magical:

1. Reads the same resolved config as `jeoc agent`.
2. Prints Bun runtime, provider, model, API key source, max turns, and config path.
3. Marks whether the selected model is known or custom.
4. Fails with `NOT READY` when a real provider has no API key.
5. With `--live`, checks Gemini's live model list for the configured key.
6. With `--probe`, performs a minimal provider call; tests use `mock` so this is hermetic.

## Verification evidence

Observed terminal checks:

```text
bun test
→ 23 pass, 0 fail

jeoc doctor --live
→ gemini liveModels 37, selected available, status READY

jeoc agent "Create file live-check.txt containing exactly jeoc-live-ok, then read it back and report the content." --max 6
→ write_file(live-check.txt), read_file(live-check.txt), final report; file content jeoc-live-ok
```

This proves the flow from install/link → setup → provider/model readiness → live terminal coding-agent tool loop.

This is the terminal equivalent of GJC's layered provider/model/auth readiness checks, reduced to a zero-dependency Bun CLI.

## Current implementation status

- `bin/jeoc.ts`: exposes `doctor` alongside `agent`, `setup`, `models`, `config`, `autopilot`, and `ledger`.
- `src/setup.ts`: owns `KNOWN_MODELS`, `runSetup`, `runModels`, and `runDoctor`.
- `test/agent.test.ts`: covers mock doctor probe and real-provider missing-key failure.
- `README.md`: documents install, setup, doctor, models, and agent flow.

## Deliberate simplifications vs gajae-code

- No SQLite credential pool or OAuth broker yet; `.jeoc/config.json` + env vars are the MVP.
- No streaming UI/TUI yet; `jeoc agent` consumes complete provider responses.
- No full model cache database yet; only Gemini live listing is implemented because it directly supports the requested provider/model setup validation.

These are acceptable for `jeo-code`'s current goal: a small, actually runnable coding-agent CLI that mirrors GJC's core boundaries without copying the full platform.
