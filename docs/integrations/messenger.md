# Messenger gateway

`jeo messenger` (and `jeo discord`) sets up and runs bidirectional Discord, Telegram, and Slack conversations without public ingress. Every platform requires an explicit user allowlist; server channels can also be allowlisted.

Each conversation is a persistent worker session keyed by workspace, platform account, guild/channel or thread, and, except for Discord threads, the sender. A Discord reply thread is one shared session for every allowed participant; a DM is a per-user session; Telegram and Slack conversations always include the sender.

## Default usage: connect a running terminal session

The default Discord setup (`jeo discord setup` or `jeo messenger setup`) creates `~/.jeo/discord/messenger.json` (`toolNames: []`, `./workspace`, `./sessions`, no sandbox) and is designed for connecting Discord to a running `jeo` terminal session:

```sh
jeo discord setup
```

Then inside any running `jeo` session in your terminal:

```text
/discord live --allow-full-control
```

- `/discord live [<messenger.json>] --allow-full-control` attaches the Discord gateway directly to that running terminal session (`allowedChannelIds` must be non-empty). `toolNames` in `messenger.json` is ignored; Discord requests use the live session's active tools, approval policy, and working directory (`cwd` is not a sandbox or filesystem jail).
- `/discord status` prints live bridge and daemon control state, `cwd`, and active tools.
- `/discord relay <allowed-channel-id|off>` forwards eligible direct local answers to the selected Discord channel.
- `/discord stop` disconnects the live bridge and revokes remote access.

You can also connect via the shared notification daemon (`jeo notify setup --provider discord` + `jeo daemon start` + `/discord control on --allow-full-control`). No sandbox is required.

## Standalone gateway (`jeo messenger run`)

For an always-on background gateway instead of attaching to a terminal session, run:

```sh
jeo messenger setup --config ~/.jeo/discord/messenger.json [--service]
jeo messenger check --config ~/.jeo/discord/messenger.json
jeo messenger run --config ~/.jeo/discord/messenger.json
```

If `--config` is omitted, it defaults to `~/.jeo/discord/messenger.json`.

### Tools and authority (`jeopi`-compatible, not a sandbox)

`toolNames` is a unique list drawn from `read`, `grep`, `glob`, `bash`, `edit`, and `write` (`grep` maps to `search`, `glob` to `find`). **Default is `[]` (no tools enabled, chat-only).**

- **Not a sandbox:** If `bash`, `edit`, or `write` are enabled (`--tools read,grep,glob,bash,edit,write`), authorized remote users run with the local OS user's permissions on the host machine.
- **`cwd` is not a jail:** `cwd` defaults to `./workspace` (or `.` in parsed config) as the starting working directory, not a chroot or filesystem jail.
- Platform token environment variables (`JEO_DISCORD_BOT_TOKEN`, `JEO_TELEGRAM_BOT_TOKEN`, `JEO_SLACK_BOT_TOKEN`, `JEO_SLACK_APP_TOKEN`, and legacy `JEOPI_` aliases) are blanked in worker child environments.

Example configuration:

```json
{
  "cwd": "./workspace",
  "sessionDir": "./sessions",
  "toolNames": [],
  "platforms": {
    "discord": {
      "tokenEnv": "JEO_DISCORD_BOT_TOKEN",
      "allowedUserIds": ["111111111111111111"],
      "allowedChannelIds": ["222222222222222222"]
    }
  }
}
```

## Runtime and updates

A profile's gateway and every conversation worker run from one runtime recorded in its launcher (`run-discord.sh` / `run-discord.cmd`):

- **Managed runtime** (default when `jeo` itself is an npm/bun package install): setup installs a private copy of the published package under `<profile>/runtime/<version>/node_modules/jeo-code` and points the launcher at it. `jeo update` refreshes registered profiles.
- **External runtime** (setup run from a git checkout or compiled binary): the launcher embeds that entry and `jeo update` leaves it alone.

Setup and `messenger update` register the profile in `~/.jeo/notifications/messenger-profiles.json` (`JEO_CONFIG_DIR` honoured). Re-running setup without `--service` restarts an already installed service so the rewritten launcher takes effect immediately.

## Conversations and FIFO

- A server request (mention in a request channel) creates a reply thread named `Request <messageId>`; the reply is posted there.
- Later messages in that thread continue the same session and do not need a mention. Anyone allowlisted can participate.
- A DM stays in the DM channel with its own per-user session.
- Standalone gateway conversations spawn `launch --print --no-tui --literal-worker --resume <id>` processes (up to 8 resident workers, 10-minute idle timeout, concurrency 4).
- Requests in the same conversation run strictly FIFO; distinct conversations run concurrently.

## Discord model

Without an explicit Discord `model`, automatic selection uses the live account catalog and supports Anthropic Sonnet, OpenAI Terra, and Antigravity Gemini Flash based on the default provider. Other providers require an explicit Discord `model`.

Discord's platform object may specify `"model": "antigravity/gemini-3.8-flash-medium"` and `"usageFallbackModel": "gpt-6.1-terra"`. `usageFallbackModel` requires `model` and triggers only on a persistent usage/quota failure on the first step.

## Discord attachments

Input accepts at most 10 files, at most 8 MiB each, only over HTTPS from `cdn.discordapp.com` or `media.discordapp.net` under `/attachments/`. Redirects, URL credentials, size mismatches, traversal, and symlinks are rejected. Output requires `artifactDir`, an existing non-symlink directory (`setup --artifacts` creates `./artifacts`); only regular files beneath it are uploaded, with the same 10-file and 8 MiB limits.
