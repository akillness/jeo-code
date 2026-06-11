import { exportSession, latestSessionId, loadSession } from "../agent/session";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function renderSessionHtml(
  meta: { id: string; timestamp?: string; [key: string]: any },
  messages: { role: string; content: string }[]
): string {
  const escapeHtml = (text: string): string => {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const messageHtml = messages
    .map(m => {
      const roleClass = (m.role === "system" || m.role === "user" || m.role === "assistant") ? m.role : "other";
      return `  <div class="message ${roleClass}">
    <div class="role-label">${escapeHtml(m.role)}</div>
    <pre>${escapeHtml(m.content)}</pre>
  </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Session ${escapeHtml(meta.id)}</title>
  <style>
    body {
      background-color: #121212;
      color: #e0e0e0;
      font-family: Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace;
      padding: 24px;
      margin: 0;
      line-height: 1.5;
    }
    .header {
      margin-bottom: 24px;
      border-bottom: 1px solid #333;
      padding-bottom: 16px;
    }
    .header h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      color: #ffffff;
    }
    .header p {
      margin: 0;
      font-size: 14px;
      color: #888888;
    }
    .message {
      margin: 16px 0;
      padding: 16px;
      border-radius: 6px;
      border-left: 4px solid #555;
    }
    .message.system {
      background-color: #1c1c1c;
      border-left-color: #888888;
    }
    .message.user {
      background-color: #172a3a;
      border-left-color: #3b82f6;
    }
    .message.assistant {
      background-color: #143224;
      border-left-color: #10b981;
    }
    .role-label {
      font-weight: bold;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .message.system .role-label {
      color: #aaaaaa;
    }
    .message.user .role-label {
      color: #60a5fa;
    }
    .message.assistant .role-label {
      color: #34d399;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
      font-family: inherit;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Session: ${escapeHtml(meta.id)}</h1>
    ${meta.timestamp ? `<p>Timestamp: ${escapeHtml(meta.timestamp)}</p>` : ""}
  </div>
${messageHtml}
</body>
</html>`;
}

/**
 * `jeo export [id] [--json] [--system] [--html] [--out <path>]` — print a saved session transcript
 * (Markdown by default; `--json` for structured; `--system` to include system
 * messages). Defaults to the latest session when no id is given.
 */
export async function runExportCommand(args: string[] = []): Promise<void> {
  const htmlMode = args.includes("--html");
  const jsonMode = args.includes("--json");
  const includeSystem = args.includes("--system");

  if (htmlMode && jsonMode) {
    console.error("Error: --html and --json options are mutually exclusive.");
    process.exitCode = 1;
    return;
  }

  // Parse --out <path>
  let outPath: string | undefined;
  const outIdx = args.indexOf("--out");
  if (outIdx !== -1 && outIdx + 1 < args.length) {
    outPath = args[outIdx + 1];
  }

  // Find the session ID: first non-flag argument that is not the value after --out
  let id: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      continue;
    }
    if (outIdx !== -1 && i === outIdx + 1) {
      continue;
    }
    id = arg;
    break;
  }

  if (!id) {
    id = await latestSessionId();
  }

  if (!id) {
    console.log("No session to export. Pass a session id or run a session first.");
    return;
  }

  if (htmlMode) {
    try {
      const { header, messages } = await loadSession(id, process.cwd());
      const picked = includeSystem ? messages : messages.filter(m => m.role !== "system");
      const html = renderSessionHtml(header, picked);
      const resolvedOutPath = outPath
        ? path.resolve(process.cwd(), outPath)
        : path.join(process.cwd(), `jeo-session-${id}.html`);
      await fs.writeFile(resolvedOutPath, html, "utf8");
      console.log(resolvedOutPath);
    } catch (err) {
      console.log(`Could not export session ${id}: ${(err as Error).message}`);
    }
  } else {
    const format: "markdown" | "json" = jsonMode ? "json" : "markdown";
    try {
      console.log(await exportSession(id, format, process.cwd(), { includeSystem }));
    } catch (err) {
      console.log(`Could not export session ${id}: ${(err as Error).message}`);
    }
  }
}
