import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  jeoHomeDir,
  notifyDir,
  notifySessionsDir,
  notifySessionEndpointPath,
  notifyDaemonLockPath,
  notifyDaemonLogPath,
} from "../src/agent/notify/paths";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-paths-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

test("jeoHomeDir honors JEO_CONFIG_DIR", () => {
  expect(jeoHomeDir()).toBe(dir);
});

test("notifyDir/notifySessionsDir nest under the jeo home dir", () => {
  expect(notifyDir()).toBe(path.join(dir, "notifications"));
  expect(notifySessionsDir()).toBe(path.join(dir, "notifications", "sessions"));
});

test("notifySessionEndpointPath names the file <sessionId>.json under sessions/", () => {
  expect(notifySessionEndpointPath("abc-123")).toBe(path.join(dir, "notifications", "sessions", "abc-123.json"));
});

test("daemon lock/log paths live directly under notifications/", () => {
  expect(notifyDaemonLockPath()).toBe(path.join(dir, "notifications", "daemon.lock"));
  expect(notifyDaemonLogPath()).toBe(path.join(dir, "notifications", "daemon.log"));
});

test("falls back to ~/.jeo when JEO_CONFIG_DIR is unset", () => {
  delete process.env.JEO_CONFIG_DIR;
  expect(jeoHomeDir()).toBe(path.join(os.homedir(), ".jeo"));
});
