// Preloaded only by the source PTY case; acknowledge after launch's synchronous stdin handlers.
process.stdin.on("data", chunk => {
  const data = String(chunk);
  setImmediate(() => process.send?.({ type: "stdin-consumed", data }));
});
