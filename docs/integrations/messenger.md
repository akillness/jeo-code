# Messenger gateway

`jeo messenger` runs bidirectional Discord, Telegram, and Slack conversations without public ingress. Every platform requires an explicit user allowlist; server channels can also be allowlisted.

Each conversation is a persistent worker session keyed by workspace, platform account, guild/channel or thread, and, except for Discord threads, the sender. A Discord reply thread is one shared session for every allowed participant; a DM is a per-user session; Telegram and Slack conversations always include the sender.

## Sandbox (required for remote execution)

Messenger requires an effective sandbox for every platform: a `sandbox` block in the messenger file or an inherited global `sandbox`. Discord requires the block in the messenger file itself. Every platform in the file runs its tools in session-specific containers, and sandbox failures never fall back to host execution.

```json
{
  "cwd": "./workspace",
  "sessionDir": "./messenger-sessions",
  "sandbox": {
    "image": "my-linux-bun:local",
    "limits": { "memoryBytes": 1073741824, "pids": 256, "cpus": 2 }
  },
  "toolNames": ["read", "find", "search", "write", "edit", "bash", "sandbox_request"],
  "platforms": {
    "discord": {
      "tokenEnv": "JEO_DISCORD_BOT_TOKEN",
      "allowedUserIds": ["111111111111111111"],
      "allowedChannelIds": ["222222222222222222"]
    }
  }
}
```

Source anchors: `parseMessengerSandbox` and `validateSandboxConfig` (`src/messenger/config.ts`, `src/agent/sandbox/policy.ts`) accept only `sandbox.image` and `sandbox.limits.{memoryBytes,pids,cpus}`; `memoryBytes` and `pids` must be positive safe integers and `cpus` a positive finite number. Choose values your image needs; no default exists.

Requirements the sandbox enforces (`src/agent/sandbox/docker.ts`):

- `image` is an already-local Linux image with Bun at `/usr/local/bin/bun`. Pulls are disabled (`--pull=never`); the Docker endpoint must be local (`unix://` or `npipe://`); remote contexts are rejected.
- The host controller must not run as root.
- Containers run with `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, a private `/tmp`, and the configured pids/memory/cpus limits.
- Only the workspace (`cwd`, mounted at `/workspace`) and approved grants are mounted. `sessionDir` must be outside and disjoint from `cwd`.

`setup` prompts for the image and limits unless the target config already has a valid `sandbox` block. For unattended setup, write that block first.

## Discord quick setup

Create a Discord application and bot in the Developer Portal, copy its token, then run:

```sh
jeo messenger setup --config ~/.jeo/discord/messenger.json --service
```

Setup validates the bot, enables Message Content intent when Discord permits it, discovers a request channel with the required permissions, writes a token file and a platform-native launcher (`run-discord.sh` or Windows `run-discord.cmd`), probes the Gateway, and optionally installs a macOS/Linux user service. On Windows, omit `--service` and run the `.cmd` with your process manager. Ctrl+C cancels an active prompt, invite wait, or Gateway probe.

Non-interactive choices: `--channel ID`, `--user ID`, `--tools LIST`, `--artifacts`, `--no-dm`. When `--tools` is omitted, setup writes `read, find, search, write, edit, bash, computer`. Under a sandbox, omit `computer` unless your image supports the action you want (see Tools) and add `sandbox_request` if the model should be able to request access.

The bot needs View Channel, Send Messages, Read Message History, Add Reactions, Attach Files, Create Public Threads, and Send Messages in Threads.

On Windows, setup's file mode does not establish or verify a private NTFS ACL. Before setup, create the profile directory with Windows permissions that restrict access to the intended account and administrators; after setup, verify that the token file's ACL is also appropriately restricted before running the launcher. Windows ACL protection has not been verified by this setup flow.

The Windows launcher inherits PATH from the environment that starts it; it does not preserve the setup-time PATH. Its embedded executable path and configuration filename must currently contain only ASCII characters. Windows console and launcher behavior have not been verified on a real Windows host.

## Check and run

```sh
jeo messenger check --config /absolute/private/path/messenger.json
jeo messenger run --config /absolute/private/path/messenger.json
```

`check` validates JSON, storage placement, and credential presence locally; it performs no network calls and does not probe the sandbox image. Credentials default to `JEO_DISCORD_BOT_TOKEN`, `JEO_TELEGRAM_BOT_TOKEN`, `JEO_SLACK_BOT_TOKEN`, and `JEO_SLACK_APP_TOKEN`; equivalent `JEOPI_` names are accepted during migration. Platform token variables are blanked (set to empty) in agent child-process environments.

Messenger workers run with `--no-skills`, so installing `jeo-skills` is not required and remote messages cannot activate local skill instructions. Restart the messenger service after any configuration change.

## Tools and authority

`toolNames` is a unique list drawn from `read`, `grep`, `glob`, `find`, `search`, `bash`, `edit`, `write`, `computer`, and `sandbox_request` (`grep` maps to `search`, `glob` to `find`). If omitted, the default is `read, find, search, write, edit, bash, computer, sandbox_request`. Every allowlisted user and platform in the same file receives the same tools.

All messenger model and tool execution is remote execution and requires an effective sandbox. The effective sandbox is the messenger file's `sandbox` block or, when the file has none, the global `sandbox` configuration that the worker inherits. Messenger workers are literal workers (`--literal-worker`) and carry a session key; `launch` fails with `SANDBOX_REQUIRED` if neither source supplies a sandbox (`src/commands/launch.ts`). There is no host fallback for any platform, including Telegram and Slack: tools execute inside the container described above and see only the workspace and approved grants, with no network.

Discord additionally requires a sandbox in the messenger file itself; the parser rejects a Discord configuration without a local `sandbox` block, so a global sandbox alone does not satisfy Discord. Do not configure Telegram or Slack without an effective sandbox: it fails at worker launch rather than running on the host. Host execution applies only to ordinary local, non-remote CLI sessions, not to messenger.

`computer` is an explicit per-worker opt-in and runs only inside the sandbox guest. The trusted parent wrapper forwards the opt-in consent to `__computer` inside the guest, never to the host, and the host desktop is inaccessible. Only the `wait` action combined with file workflows has been verified (see Verification status). GUI and browser tools work only if your local image already contains the needed capabilities; nothing installs dependencies for you. Omit `computer` unless your image supports the action you want.

Example for a sandboxed Telegram file (the `sandbox` block is as shown above):

```json
"toolNames": ["read", "find", "search", "write", "edit", "bash", "sandbox_request"]
```

## Conversations and FIFO

- A server request (mention in a request channel) creates a reply thread named `Request <messageId>`; the reply is posted there.
- Later messages in that thread continue the same session and do not need a mention. Anyone allowlisted can participate.
- A DM stays in the DM channel with its own per-user session.
- Messenger conversations are headless `launch --print --literal-worker --resume <id>` processes, one reusable worker per conversation. They do not attach to an interactive `jeo` terminal session.
- Requests are queued in arrival order. One turn runs per conversation at a time; different conversations run concurrently (the CLI uses concurrency 4). Authenticated `/sandbox` controls bypass the model queue.

## Sandbox grants and revocation

The model can call `sandbox_request` to ask for access to a host path in `ro` or `rw` mode. A request never grants itself.

Only allowlisted Discord users can decide a request, and only by sending the command inside that conversation (thread or DM). Each command reaches the conversation's live worker; if the worker is not running, the command fails.

- `/sandbox status`: shows the session revision, grants, and pending requests.
- `/sandbox approve <requestId>` and `/sandbox deny <requestId>`: decide a pending request.
- `/sandbox revoke`: removes grants and confirms owned containers are gone. If removal cannot be confirmed, the command returns a `Sandbox control error`.

Source: `sandboxControl` (`src/commands/messenger.ts`) and `handleSandboxControl` (`src/agent/sandbox/control.ts`).

## Private history migration

Startup refuses a sandboxed configuration when legacy transcripts or raw history are inside the workspace: `.jeo/sessions`, `.jeo/messenger-sessions`, and `.jeo/memory/raw`, if they contain `.json`/`.jsonl` files or symlinks. Relocate them to a private directory outside the workspace; do not delete them. The default `sessionDir` is in the private notify directory.

The obsolete `independentSessions` key is rejected by `messenger run`. `messenger setup` removes it and keeps one persistent session per Discord thread.

## Discord model

Without an explicit Discord `model`, automatic selection uses the live account catalog and supports only Anthropic Sonnet, OpenAI Terra, and Antigravity Gemini Flash, based on the default provider. Other default providers require an explicit Discord `model`. Explicit models must also appear in live discovery and be accessible with the runtime credentials; no static or unverified model is substituted. If verification fails, check the configured model, provider login and live discovery, then restart the messenger service after configuration changes.

Discord's platform object may specify `"model": "antigravity/gemini-3.8-flash-medium"` and `"usageFallbackModel": "gpt-6.1-terra"`. This pins that Discord worker independently of global routing; other platforms are unchanged. `usageFallbackModel` requires `model`. The fallback requires its own usable credentials and is attempted only for a persistent usage/quota failure on the first step, before any tool could have run. Transient rate limits, authentication failures and later failures do not trigger it. Restart the messenger service after editing the configuration.

## Discord request progress

While a request runs, Discord shows one silently updated progress message in the reply thread or DM. It shows fixed status text, the current step and validated tool names, then marks the request complete, failed or cancelled. Updates are throttled and coalesced, so fast intermediate steps may not appear. Model reasoning, tool arguments, tool output and provider error details are not included in progress messages; the final answer is sent separately.

## Discord attachments

Input accepts at most 10 files, at most 8 MiB each, only over HTTPS from `cdn.discordapp.com` or `media.discordapp.net` under `/attachments/`. Redirects, URL credentials, size mismatches, traversal, and symlinks are rejected. Output requires `artifactDir`, an existing non-symlink directory (`setup --artifacts` creates `./artifacts`); only regular files beneath it are uploaded, with the same 10-file and 8 MiB limits.

Under a sandbox, `artifactDir` must lie inside the workspace (`cwd`) or inside a human-approved grant mount. The worker receives the artifact directory as an absolute host path; the supervisor rewrites absolute host paths under an existing mount to the matching guest path (`guestPath` in `src/agent/sandbox/supervisor.ts`), but only in tool path arguments (`filePath`, `path`, `dirPath`, `dir`, `targetPath`, `cwd`, `subdir`), not inside free-form shell command strings. A directory outside the initial mounts is not reachable from the container and gains no automatic authority; adding it requires an explicit approval through the grant flow above. `setup --artifacts` writes `./artifacts` beside `./workspace`, which is outside the initial mounts, so set `artifactDir` inside the workspace for sandboxed use.

## Verification status

- **Full repository regression**: `bun test` with `JEO_TEST_TERMINAL_FIFO=1` and inherited provider credentials/base-URL overrides cleared for the test process passed 4,437 tests, with 4 existing conditional skips and 0 failures (4,441 total across 386 files).
- **macOS arm64 host / Linux x64 guest verifier**: `bun run verify:sandbox` passed 20 contracts, confirmed container removal, and removed its fixtures. `bun run build` and `bun run typecheck` passed.
- **Copied standalone binary (`dist/jeo`)**: with `JEO_TEST_TERMINAL_FIFO=1` and `JEO_TEST_CLI_BINARY` set to the absolute `dist/jeo` path, `bun test test/sandbox-terminal-fifo.test.ts test/sandbox-requester-reachability.test.ts test/sandbox-metadata-privacy.test.ts test/sandbox-worker-ipc-shutdown.test.ts` passed 16 tests, 0 failed, 151 assertions. This verified the actual private-IPC transport: bad frames were rejected; active guest shutdown used no signals, got a matching stderr ACK, exited 143, and removed the container; natural EOF exited 0; and immediate startup shutdown occurred before any model call.
- **Protected-worker shutdown**: the parent sends an exact nonce frame over a private Bun IPC channel instead of SIGTERM. The gate remains the worker's cleanup ACK plus its actual exit. If IPC `send` is missing or throws, the worker is quarantined; there is no SIGTERM/SIGKILL fallback. Signal-only termination is not relied on for Windows. The focused pool tests passed 75, 0 failed.
- **Computer in the guest**: `bun test test/messenger-literal-launch.test.ts` passed (7 pass, 0 fail), including an enabled guest `wait` plus file-write workflow and an explicit disabled opt-in. Only that narrow `wait`+file workflow is verified; GUI/browser actions are not.
- **Current source wrappers** preserve the teardown cleanup owner, bounded shutdown waits, human per-session grants, one persistent thread/FIFO, and the shared workspace.
- **Linux x64 GitHub Actions dry-run (separate from the macOS checks above)**: Ubuntu 24.04 [run 41696052194](https://github.com/akillness/jeo-code/actions/runs/41696052194) at source `d44ef5a1b1ec5b44e4607dfc20976f73b3b92265` is COMPLETED SUCCESS. Primary `bun test`: 4422 pass, 19 skip, 0 fail, 4441 total across 386 files. The separate mandatory browser step passed 15, 0 failed (those 15 cases were skipped in the primary process), leaving 4 existing conditional skips.
- **Native Linux sandbox verifier**: the real native Ubuntu 24.04 / Linux x64 verifier passed 20 contracts. Collision evidence: `hostSentinelsUnchanged=true`, `unwritableNamespaceWriteDenied=true`, `tmpNamespaceCollision=true`, `collisionWriteWasGuestPrivate=true`.
- **Packaging dry-run**: `pack:check` passed 329 files; the packed CLI runner and launch booted; the npm dry-run passed. In run 41696052194 itself, no real npm publish occurred and the binary job was intentionally skipped; this describes only that dry-run.
- **Linux `/tmp` namespace-collision proof**: verifies host-sentinel preservation, the session-private `/tmp` shadow, and a denied write to the unwritable namespace together. It tightens the test, implies no production escape, and weakens nothing.
- **Native Windows host** (launcher, ACL, Docker sandbox): not qualified. A Linux guest on macOS does not prove it; see the Windows notes above.
- **Not claimed**: all-OS qualification, GUI/browser computer-action qualification, native Windows host qualification, or live Discord qualification. These rehearsal results alone do not prove registry publication.

Stable commands: `bun run build:hands` and `bun run verify:sandbox`, plus the copied-binary qualification command above.
