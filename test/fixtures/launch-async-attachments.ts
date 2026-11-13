import { spyOn } from "bun:test";
import * as path from "node:path";
import * as clipboardImage from "../../src/util/clipboard-image";
import * as clipboardText from "../../src/tui/clipboard";
import * as fileAttachment from "../../src/util/file-attachment";
import type { ImageAttachment } from "../../src/ai/types";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const image: ImageAttachment = { mediaType: "image/png", data: Buffer.from(png).toString("base64") };

type Control = { type: "release"; id: number; value: "image" | "text" | "none"; text?: string };

if (process.env.JEO_ASYNC_ATTACHMENT_CHILD === "1") {
  let sequence = 0;
  const pending = new Map<number, (control: Control) => void>();
  const read = <T>(kind: string, resolve: (control: Control) => T): Promise<T> => {
    const id = ++sequence;
    const gate = Promise.withResolvers<Control>();
    pending.set(id, gate.resolve);
    process.send?.({ type: "read-started", kind, id });
    return gate.promise.then(control => {
      pending.delete(id);
      // This acknowledgement runs after launch has consumed the resolved read.
      setImmediate(() => process.send?.({ type: "read-settled", kind, id }));
      return resolve(control);
    });
  };
  const realAttach = fileAttachment.attachImagePaths;
  const spies = [
    spyOn(clipboardImage, "readClipboardImage").mockImplementation(() => read("clipboard-image", control => control.value === "image" ? image : null)),
    spyOn(clipboardText, "readClipboardText").mockImplementation(() => read("clipboard-text", control => control.value === "text" ? control.text ?? "" : null)),
    spyOn(fileAttachment, "attachImagePaths").mockImplementation(async (text, startNumber) => {
      const result = await realAttach(text, startNumber, () => read("drop-file", () => png));
      process.send?.({ type: "attachment-result", input: text, output: result.text, images: result.images.length });
      return result;
    }),
  ];
  process.stdin.on("data", chunk => {
    const data = String(chunk);
    setImmediate(() => process.send?.({ type: "stdin-consumed", data }));
  });
  process.on("message", (message: Control) => {
    if (message?.type === "release") pending.get(message.id)?.(message);
  });
  process.on("exit", () => { for (const spy of spies) spy.mockRestore(); });
} else {
  // Keep the PTY leader alive until the launched session revokes its real sandbox.
  const child = Bun.spawn([
    process.execPath, "--preload", import.meta.path,
    path.resolve(import.meta.dir, "../../src/cli.ts"),
    "launch", "--no-skills", "--no-session", "--model", "openai/async-fixture-model",
  ], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, JEO_ASYNC_ATTACHMENT_CHILD: "1" },
    ipc(message) { process.send?.(message); },
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    process.exit(0);
  };
  process.on("message", message => {
    if (message === "stop") void stop();
    else child.send(message);
  });
  process.on("disconnect", () => { void stop(); });
  const exitCode = await child.exited;
  process.send?.({ type: "exit", exitCode });
  if (!stopping) await Promise.withResolvers<void>().promise;
}
