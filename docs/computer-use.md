# Desktop computer use

Enable the desktop tool for one interactive session with `/computer on`; `/computer off` disables it again. For CLI use, set `computer.enabled: true` in the jeo configuration. This does not grant operating-system permissions. Use an image-capable model to inspect screenshots.

## Requirements

- **macOS:** `screencapture` (built in) for screenshots, `cliclick` for mouse/keyboard input, and built-in `osascript`/Quartz for scrolling. Install `cliclick` yourself if missing (`brew install cliclick`). Grant Screen Recording and Accessibility permission to the terminal/application running jeo in System Settings → Privacy & Security. Relaunch the host after changing permissions if macOS requires it.
- **Linux/X11:** `scrot` for screenshots and `xdotool` for input, with access to the active X display. Native Wayland input is not supported by this backend.
- **Windows:** this desktop backend is not supported; it returns an explicit error rather than attempting Linux commands.

The configuration gate and fail-closed supervisor remain in force. jeo does not automatically install tools or change OS privacy settings.

## Actions

- `screenshot` returns a PNG image attachment to the model, not base64 text. Image attachments also survive a `batch`, including native Anthropic and OpenAI Responses tool replay. `jeo computer screenshot` retains base64 stdout for shell callers.
- `click`, `double_click`, and `move` use desktop coordinates. `drag` starts at the current pointer location, moves to `x,y`, then releases the mouse button.
- `scroll` accepts integer `deltaX` and `deltaY` from -1000 to 1000. Positive Y scrolls up, negative Y down; positive X scrolls right. Zero deltas are a no-op. macOS uses Quartz line events, not cliclick's `w:` command (which only waits).
- `type` enters text. `keypress` accepts native key names; on macOS common aliases such as `Return`, `Enter`, `Escape`, `ArrowDown`, and modifier combinations such as `Command+Return` are normalized. Modifiers are released after the keypress.
- `wait` accepts a finite duration from 0 to 60 seconds. All numeric inputs must be finite.
- `batch` runs actions sequentially and stops on the first failure. Each action still checks the supervisor; a stale heartbeat is not bypassed.

## Troubleshooting

A missing executable, denied OS permission, or unavailable display is an execution failure, not a successful action. A successful screenshot only proves capture works; it does not establish Accessibility permission or that a click changed the intended application. Verify visible state after input. Screen coordinates can differ from screenshot pixels on scaled/Retina displays; do not assume a universal 1:1 ratio.
