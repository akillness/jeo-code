// Remain the session leader until cleanup, even if the CLI exits before its provider.
// Only the leader signals its own group, so a recycled PID can never be targeted.
const stop = () => process.kill(-process.pid, "SIGKILL");
process.on("message", message => { if (message === "stop") stop(); });
process.on("disconnect", stop);
const child = Bun.spawn(process.argv.slice(2), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
process.send?.({ type: "exit", exitCode });
await Promise.withResolvers<void>().promise;
