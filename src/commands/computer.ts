import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { computerSupervisor } from "../agent/computer-supervisor";
import { readGlobalConfig } from "../agent/state";

export interface ComputerAction {
  action: "screenshot" | "click" | "double_click" | "move" | "drag" | "scroll" | "type" | "keypress" | "wait" | "batch";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  duration?: number;
  actions?: ComputerAction[];
}

async function logAudit(action: ComputerAction, success: boolean, error?: string) {
  try {
    const auditDir = path.join(process.cwd(), ".jeo");
    await fs.mkdir(auditDir, { recursive: true });
    const auditPath = path.join(auditDir, "computer-audit.jsonl");
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      success,
      error,
    }) + "\n";
    await fs.appendFile(auditPath, logEntry, "utf-8");
  } catch {
    // best-effort
  }
}

async function runCommand(cmd: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return {
      success: proc.exitCode === 0,
      stdout,
      stderr,
    };
  } catch (err: any) {
    return {
      success: false,
      stdout: "",
      stderr: err.message || String(err),
    };
  }
}

export async function executeComputerAction(action: ComputerAction, opts?: { enabledOverride?: boolean }): Promise<{ success: boolean; output: string; error?: string }> {
  let enabled = opts?.enabledOverride;
  if (enabled === undefined) {
    const config = await readGlobalConfig().catch(() => null);
    enabled = !!config?.computer?.enabled;
  }
  if (!enabled) {
    return {
      success: false,
      output: "",
      error: "Computer use is disabled. Enable it by running '/computer on' this session, or setting 'computer.enabled: true' in ~/.jeo/config.json",
    };
  }


  // Read-only actions don't need supervisor inputAllowed check
  const isReadOnly = action.action === "screenshot" || action.action === "wait";
  if (!isReadOnly) {
    if (!computerSupervisor.inputAllowed) {
      const err = "Action blocked by fail-closed supervisor (kill switch not live, heartbeat stale, or suspended).";
      await logAudit(action, false, err);
      return { success: false, output: "", error: err };
    }
  }

  const isMac = os.platform() === "darwin";

  switch (action.action) {
    case "screenshot": {
      const tmpDir = os.tmpdir();
      const screenPath = path.join(tmpDir, `jeo-screen-${Date.now()}.png`);
      let cmd: string[];
      if (isMac) {
        cmd = ["screencapture", "-x", screenPath];
      } else {
        cmd = ["scrot", "-z", screenPath];
      }
      const res = await runCommand(cmd);
      if (!res.success) {
        await logAudit(action, false, res.stderr);
        return { success: false, output: "", error: `Failed to capture screenshot: ${res.stderr}` };
      }
      try {
        const bytes = await fs.readFile(screenPath);
        const base64 = bytes.toString("base64");
        await fs.unlink(screenPath).catch(() => {});
        await logAudit(action, true);
        return { success: true, output: base64 };
      } catch (err: any) {
        await logAudit(action, false, err.message);
        return { success: false, output: "", error: `Failed to read screenshot file: ${err.message}` };
      }
    }

    case "click": {
      if (action.x === undefined || action.y === undefined) {
        return { success: false, output: "", error: "Missing coordinates x and y for click action." };
      }
      let cmd: string[];
      if (isMac) {
        cmd = ["cliclick", `c:${action.x},${action.y}`];
      } else {
        cmd = ["xdotool", "mousemove", String(action.x), String(action.y), "click", "1"];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Clicked at (${action.x}, ${action.y})` }
        : { success: false, output: "", error: `Click failed: ${res.stderr}` };
    }

    case "double_click": {
      if (action.x === undefined || action.y === undefined) {
        return { success: false, output: "", error: "Missing coordinates x and y for double_click action." };
      }
      let cmd: string[];
      if (isMac) {
        cmd = ["cliclick", `dc:${action.x},${action.y}`];
      } else {
        cmd = ["xdotool", "mousemove", String(action.x), String(action.y), "click", "--repeat", "2", "--delay", "100", "1"];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Double clicked at (${action.x}, ${action.y})` }
        : { success: false, output: "", error: `Double click failed: ${res.stderr}` };
    }

    case "move": {
      if (action.x === undefined || action.y === undefined) {
        return { success: false, output: "", error: "Missing coordinates x and y for move action." };
      }
      let cmd: string[];
      if (isMac) {
        cmd = ["cliclick", `m:${action.x},${action.y}`];
      } else {
        cmd = ["xdotool", "mousemove", String(action.x), String(action.y)];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Moved cursor to (${action.x}, ${action.y})` }
        : { success: false, output: "", error: `Move failed: ${res.stderr}` };
    }

    case "drag": {
      if (action.x === undefined || action.y === undefined) {
        return { success: false, output: "", error: "Missing coordinates x and y for drag action." };
      }
      let cmd: string[];
      if (isMac) {
        cmd = ["cliclick", `dd:${action.x},${action.y}`];
      } else {
        cmd = ["xdotool", "mousemove", String(action.x), String(action.y), "mousedown", "1"];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Dragged to (${action.x}, ${action.y})` }
        : { success: false, output: "", error: `Drag failed: ${res.stderr}` };
    }

    case "scroll": {
      let cmd: string[];
      const dx = action.deltaX ?? 0;
      const dy = action.deltaY ?? 0;
      if (isMac) {
        // cliclick scroll deltaY deltaX
        cmd = ["cliclick", `w:${dy},${dx}`];
      } else {
        // xdotool click 4 (scroll up), 5 (scroll down), 6 (scroll left), 7 (scroll right)
        const actions: string[] = [];
        if (dy > 0) {
          for (let i = 0; i < dy; i++) actions.push("click", "4");
        } else if (dy < 0) {
          for (let i = 0; i < -dy; i++) actions.push("click", "5");
        }
        if (dx > 0) {
          for (let i = 0; i < dx; i++) actions.push("click", "7");
        } else if (dx < 0) {
          for (let i = 0; i < -dx; i++) actions.push("click", "6");
        }
        cmd = ["xdotool", ...actions];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Scrolled by deltaX=${dx}, deltaY=${dy}` }
        : { success: false, output: "", error: `Scroll failed: ${res.stderr}` };
    }

    case "type": {
      if (action.text === undefined) {
        return { success: false, output: "", error: "Missing text for type action." };
      }
      let cmd: string[];
      if (isMac) {
        cmd = ["cliclick", `t:${action.text}`];
      } else {
        cmd = ["xdotool", "type", action.text];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Typed text: ${action.text}` }
        : { success: false, output: "", error: `Type failed: ${res.stderr}` };
    }

    case "keypress": {
      if (action.key === undefined) {
        return { success: false, output: "", error: "Missing key for keypress action." };
      }
      let cmd: string[];
      if (isMac) {
        cmd = ["cliclick", `kp:${action.key}`];
      } else {
        cmd = ["xdotool", "key", action.key];
      }
      const res = await runCommand(cmd);
      await logAudit(action, res.success, res.success ? undefined : res.stderr);
      return res.success
        ? { success: true, output: `Pressed key: ${action.key}` }
        : { success: false, output: "", error: `Keypress failed: ${res.stderr}` };
    }

    case "wait": {
      const ms = (action.duration ?? 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, ms));
      await logAudit(action, true);
      return { success: true, output: `Waited for ${action.duration ?? 1} seconds` };
    }

    case "batch": {
      if (!action.actions || !Array.isArray(action.actions)) {
        return { success: false, output: "", error: "Missing actions array for batch action." };
      }
      const results: string[] = [];
      for (let i = 0; i < action.actions.length; i++) {
        const subAction = action.actions[i];
        const res = await executeComputerAction(subAction, opts);

        if (!res.success) {
          const err = `Batch failed at step ${i}: ${res.error}`;
          await logAudit(action, false, err);
          return { success: false, output: results.join("\n"), error: err };
        }
        results.push(`Step ${i}: ${res.output}`);
      }
      await logAudit(action, true);
      return { success: true, output: results.join("\n") };
    }

    default:
      return { success: false, output: "", error: `Unknown computer action: ${(action as any).action}` };
  }
}

export async function runComputerCommand(args: string[]): Promise<void> {
  const actionName = args[0];
  if (!actionName) {
    console.log("Usage: jeo computer <action> [args]");
    console.log("Actions: screenshot, click, double_click, move, drag, scroll, type, keypress, wait, batch");
    return;
  }

  const action: ComputerAction = { action: actionName as any };

  // Parse arguments based on action
  if (actionName === "click" || actionName === "double_click" || actionName === "move" || actionName === "drag") {
    const x = parseInt(args[1] ?? "");
    const y = parseInt(args[2] ?? "");
    if (isNaN(x) || isNaN(y)) {
      console.error(`Error: ${actionName} requires x and y coordinates.`);
      process.exit(1);
    }
    action.x = x;
    action.y = y;
  } else if (actionName === "type") {
    const text = args.slice(1).join(" ");
    if (!text) {
      console.error("Error: type requires text.");
      process.exit(1);
    }
    action.text = text;
  } else if (actionName === "keypress") {
    const key = args[1];
    if (!key) {
      console.error("Error: keypress requires a key name.");
      process.exit(1);
    }
    action.key = key;
  } else if (actionName === "scroll") {
    const dx = parseInt(args[1] ?? "0");
    const dy = parseInt(args[2] ?? "0");
    action.deltaX = dx;
    action.deltaY = dy;
  } else if (actionName === "wait") {
    const duration = parseFloat(args[1] ?? "1");
    action.duration = duration;
  } else if (actionName === "batch") {
    const jsonStr = args.slice(1).join(" ");
    try {
      action.actions = JSON.parse(jsonStr);
    } catch (err: any) {
      console.error(`Error: batch requires a valid JSON array of actions. ${err.message}`);
      process.exit(1);
    }
  }

  // Heartbeat to supervisor for CLI execution
  computerSupervisor.setKillSwitchLive(true);
  computerSupervisor.heartbeat();

  const res = await executeComputerAction(action);
  if (res.success) {
    if (actionName === "screenshot") {
      console.log(res.output); // base64 output
    } else {
      console.log(res.output);
    }
  } else {
    console.error(`Error: ${res.error}`);
    process.exit(1);
  }
}
