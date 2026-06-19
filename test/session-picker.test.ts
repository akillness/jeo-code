import { test, expect } from "bun:test";
import {
  SessionPicker,
  renderSessionPicker,
  formatBytes,
  formatRelativeTime,
} from "../src/tui/components/session-picker";
import type { SessionSummary } from "../src/agent/session";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const NOW = Date.UTC(2026, 5, 19, 12, 0, 0);

const mk = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "11111111-2222-3333-4444-555555555555",
  timestamp: "2026-06-19T00:00:00.000Z",
  cwd: "/work/proj",
  messageCount: 3,
  preview: "hello world",
  mtimeMs: NOW - 5 * 60000,
  sizeBytes: 2048,
  ...over,
});

test("formatBytes scales units", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
  expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
  expect(formatBytes(undefined)).toBe("0 B");
});

test("formatRelativeTime matches gjc phrasing", () => {
  expect(formatRelativeTime(NOW, NOW)).toBe("just now");
  expect(formatRelativeTime(NOW - 5 * 60000, NOW)).toBe("5 minutes ago");
  expect(formatRelativeTime(NOW - 60000, NOW)).toBe("1 minute ago");
  expect(formatRelativeTime(NOW - 3 * 3600000, NOW)).toBe("3 hours ago");
  expect(formatRelativeTime(NOW - 86400000, NOW)).toBe("1 day ago");
  expect(formatRelativeTime(NOW - 3 * 86400000, NOW)).toBe("3 days ago");
  expect(formatRelativeTime(undefined, NOW)).toBe("unknown");
});

test("filter narrows across id/title/preview/cwd and resets cursor", () => {
  const picker = new SessionPicker([
    mk({ id: "aaa", title: "Auth flow", preview: "fix login" }),
    mk({ id: "bbb", title: "Docs", preview: "update readme" }),
    mk({ id: "ccc", title: "Billing", preview: "stripe webhook" }),
  ]);
  picker.down(); // cursor -> bbb
  picker.setFilter("billing");
  expect(picker.visible().map(s => s.id)).toEqual(["ccc"]);
  expect(picker.selected()?.id).toBe("ccc");
  // AND of terms
  picker.setFilter("stripe webhook");
  expect(picker.visible().map(s => s.id)).toEqual(["ccc"]);
  picker.setFilter("stripe readme");
  expect(picker.visible()).toEqual([]);
});

test("up/down wrap around the filtered view", () => {
  const picker = new SessionPicker([mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })]);
  expect(picker.selected()?.id).toBe("a");
  picker.up();
  expect(picker.selected()?.id).toBe("c");
  picker.down();
  expect(picker.selected()?.id).toBe("a");
});

test("removeSelected drops the entry and keeps a valid cursor", () => {
  const picker = new SessionPicker([mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })]);
  picker.down();
  picker.down(); // -> c (last)
  const removed = picker.removeSelected();
  expect(removed?.id).toBe("c");
  expect(picker.visible().map(s => s.id)).toEqual(["a", "b"]);
  expect(picker.selected()?.id).toBe("b");
});

test("renderSessionPicker shows title, preview, relative time, size, msgs and footer", () => {
  const picker = new SessionPicker([
    mk({ id: "a", title: "Auth flow", preview: "fix login bug", messageCount: 7, sizeBytes: 2048, mtimeMs: NOW - 5 * 60000 }),
  ]);
  const lines = renderSessionPicker(picker, { title: "Resume a session", cols: 60, rows: 24, color: false, nowMs: NOW }).map(stripAnsi);
  const text = lines.join("\n");
  expect(text).toContain("Resume a session");
  expect(text).toContain("search");
  expect(text).toContain("Auth flow");
  expect(text).toContain("fix login bug");
  expect(text).toContain("5 minutes ago");
  expect(text).toContain("2.0 KB");
  expect(text).toContain("7 msgs");
  expect(text).toContain("enter resume");
  expect(text).toContain("del delete");
});

test("renderSessionPicker shows the active filter text", () => {
  const picker = new SessionPicker([mk({ id: "a", title: "Auth" })]);
  picker.setFilter("aut");
  const lines = renderSessionPicker(picker, { cols: 60, color: false, nowMs: NOW }).map(stripAnsi);
  expect(lines.some(l => l.includes("search") && l.includes("aut"))).toBe(true);
});

test("renderSessionPicker shows the delete confirmation prompt", () => {
  const picker = new SessionPicker([mk({ id: "a", title: "Auth" })]);
  const lines = renderSessionPicker(picker, { cols: 60, color: false, nowMs: NOW, confirmDeleteId: "a" }).map(stripAnsi);
  const text = lines.join("\n");
  expect(text).toContain("press Del again to delete");
  expect(text).not.toContain("2.0 KB");
});

test("renderSessionPicker handles an empty filtered view", () => {
  const picker = new SessionPicker([mk({ id: "a", title: "Auth" })]);
  picker.setFilter("zzzz");
  const lines = renderSessionPicker(picker, { cols: 60, color: false, nowMs: NOW }).map(stripAnsi);
  expect(lines.join("\n")).toContain("no sessions match");
});

test("singular vs plural message count", () => {
  const picker = new SessionPicker([mk({ id: "a", title: "Solo", messageCount: 1 })]);
  const text = renderSessionPicker(picker, { cols: 60, color: false, nowMs: NOW }).map(stripAnsi).join("\n");
  expect(text).toContain("1 msg");
  expect(text).not.toContain("1 msgs");
});
