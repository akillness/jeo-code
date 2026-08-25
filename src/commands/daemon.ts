/**
 * `jeo daemon status|start|stop|reload` — manage the background Telegram
 * notification/subagent-control daemon (gjc `gjc daemon` parity, scoped to
 * jeo's one daemon kind). See `src/agent/notify/daemon-control.ts`.
 */
import { daemonStatus, startDaemon, stopDaemon, reloadDaemon } from "../agent/notify/daemon-control";

async function printStatus(): Promise<void> {
  const status = await daemonStatus();
  if (!status.configured) {
    console.log("notifications not configured — run 'jeo notify setup' first.");
  }
  if (status.running) {
    console.log(`running (pid ${status.pid}, started ${new Date(status.startedAt!).toISOString()})`);
    // Say so when the PID-reuse guard could not actually run. On a host with no `/proc`
    // and no usable `ps` (distroless images, seccomp-hardened sandboxes) "running" is an
    // existence-only guess: the pid is alive, but it may belong to an unrelated process
    // that inherited it. Silently printing "running" there overstates what jeo checked.
    if (status.ownerVerified === false) {
      console.log("  note: this host cannot report process start times, so PID reuse could not be ruled out.");
      console.log("        'jeo daemon stop' may therefore be signalling a different process than the daemon.");
    }
  } else if (status.stale) {
    console.log("stale — a lock file exists but its pid is dead (previous daemon crashed without cleanup). 'jeo daemon start' will reclaim it.");
  } else {
    console.log("stopped");
  }
}

export async function runDaemonCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  if (action === "status" || action === "list") return printStatus();
  if (action === "start") {
    const res = await startDaemon();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (action === "stop") {
    const res = await stopDaemon();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (action === "reload") {
    const res = await reloadDaemon();
    console.log(res.message);
    if (!res.ok) process.exitCode = 1;
    return;
  }
  console.log(`Unknown 'jeo daemon' action '${action}'. Usage: jeo daemon [status|start|stop|reload]`);
  process.exitCode = 1;
}
