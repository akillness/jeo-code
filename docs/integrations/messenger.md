# Messenger gateway

`jeo messenger` runs bidirectional Discord, Telegram, and Slack conversations without public ingress. Every platform requires an explicit user allowlist; server channels can also be allowlisted. Conversations use a deterministic route per workspace, platform account, channel/thread, and sender.

## Discord quick setup

Create a Discord application and bot in the Developer Portal, copy its token, then run:

```sh
jeo messenger setup --config ~/.jeo/discord/messenger.json --service
```

Setup validates the bot, enables Message Content intent when Discord permits it, discovers a request channel with the required permissions, writes a private token file and run script, probes the Gateway, and optionally installs a user service. Use `--channel ID`, `--user ID`, `--tools read,grep`, `--artifacts`, or `--no-dm` for non-interactive choices.

The bot needs View Channel, Send Messages, Read Message History, Add Reactions, Attach Files, Create Public Threads, and Send Messages in Threads. Server requests must mention the bot; replies are isolated in threads. DMs and thread follow-ups retain separate session history.

While a request runs, Discord shows one silently updated progress message in the reply thread or DM. It retains up to six recently delivered updates (step number, tool name and outcome), then marks the request complete, failed or cancelled. Updates are throttled and coalesced, so fast intermediate steps may not appear. Tool arguments, tool output and provider error details are not included; the final answer is sent separately.

## Check and run

```sh
jeo messenger check --config /absolute/private/path/messenger.json
jeo messenger run --config /absolute/private/path/messenger.json
```

`check` validates JSON and credential presence locally and performs no network calls. Credentials default to `JEO_DISCORD_BOT_TOKEN`, `JEO_TELEGRAM_BOT_TOKEN`, `JEO_SLACK_BOT_TOKEN`, and `JEO_SLACK_APP_TOKEN`; equivalent `JEOPI_` names are accepted during migration. Tokens are removed from agent child-process environments.

Local tools default to none. Enabling them grants allowlisted remote users the corresponding host authority; it is not an OS sandbox.

For example, `"toolNames": ["read", "find", "search", "write", "edit", "computer"]` enables file operations and desktop automation in every messenger conversation using that configuration. `computer` is an explicit per-worker opt-in and does not change the global desktop setting; its supervisor and OS accessibility/screen-recording permissions still apply. All allowlisted users and platforms in the same configuration receive these tools, and they share the host desktop and filesystem, not isolated desktops. Restart the messenger service to apply changes.

Discord's platform object may specify `"model": "antigravity/gemini-3.8-flash-medium"` and `"usageFallbackModel": "gpt-6.1-terra"`. This pins that Discord worker independently of global routing; other platforms are unchanged. The fallback requires its own usable credentials and is attempted only for a persistent usage/quota failure on the first step, before any tool could have run. Transient rate limits, authentication failures and later failures do not trigger it. Restart the messenger service after editing the configuration.

## Discord attachments

Input accepts at most 10 files, at most 8 MiB each, only over HTTPS from `cdn.discordapp.com` or `media.discordapp.net` under `/attachments/`. Redirects, URL credentials, size mismatches, traversal, and symlinks are rejected. Output requires an operator-created `artifactDir`; only regular files beneath it are uploaded, with the same 10-file and 8 MiB limits.
