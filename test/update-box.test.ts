import { test, expect } from "bun:test";
import { checkForUpdate } from "../src/util/update-check";
import { renderUpdateBox } from "../src/tui/components/update-box";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visibleWidth = (s: string) => stripAnsi(s).length;

test("checkForUpdate - updateAvailable:true on higher version", async () => {
  const deps = {
    fetchJson: async () => ({ version: "2.0.0" }),
    localVersion: () => "1.0.0",
  };
  const result = await checkForUpdate(deps);
  expect(result).toEqual({
    current: "1.0.0",
    latest: "2.0.0",
    updateAvailable: true,
  });
});

test("checkForUpdate - updateAvailable:false on equal version", async () => {
  const deps = {
    fetchJson: async () => ({ version: "1.0.0" }),
    localVersion: () => "1.0.0",
  };
  const result = await checkForUpdate(deps);
  expect(result).toEqual({
    current: "1.0.0",
    latest: "1.0.0",
    updateAvailable: false,
  });
});

test("checkForUpdate - updateAvailable:false on lower version", async () => {
  const deps = {
    fetchJson: async () => ({ version: "0.9.0" }),
    localVersion: () => "1.0.0",
  };
  const result = await checkForUpdate(deps);
  expect(result).toEqual({
    current: "1.0.0",
    latest: "0.9.0",
    updateAvailable: false,
  });
});

test("checkForUpdate - null when fetchJson throws", async () => {
  const deps = {
    fetchJson: async () => {
      throw new Error("Network failed");
    },
    localVersion: () => "1.0.0",
  };
  const result = await checkForUpdate(deps);
  expect(result).toBeNull();
});

test("checkForUpdate - null when payload is malformed", async () => {
  const deps = {
    fetchJson: async () => ({ version: 123 }), // number instead of string
    localVersion: () => "1.0.0",
  };
  const result = await checkForUpdate(deps);
  expect(result).toBeNull();

  const depsMissing = {
    fetchJson: async () => ({}), // missing version
    localVersion: () => "1.0.0",
  };
  const result2 = await checkForUpdate(depsMissing);
  expect(result2).toBeNull();
});

test("renderUpdateBox - field content", () => {
  const current = "1.0.0";
  const latest = "2.0.0";
  const lines = renderUpdateBox(current, latest, { cols: 80, unicode: true, color: true });

  const joined = lines.join("\n");
  expect(joined).toContain("Update Available");
  expect(joined).not.toContain("1.0.0");
  expect(joined).toContain("2.0.0");
  expect(joined).toContain("jeo update");
});

test("renderUpdateBox - equal field widths", () => {
  const current = "1.0.0";
  const latest = "2.0.0";
  const lines = renderUpdateBox(current, latest, { cols: 80 });

  expect(lines.length).toBeGreaterThan(0);
  const expectedWidth = visibleWidth(lines[0]!);
  for (const line of lines) {
    expect(visibleWidth(line)).toBe(expectedWidth);
  }
  const plainFirst = stripAnsi(lines[0]!);
  const plainLast = stripAnsi(lines.at(-1)!);
  expect(plainFirst).toMatch(/^─+$/);
  expect(plainLast).toBe(plainFirst);
});

test("renderUpdateBox - color:false has no ANSI", () => {
  const current = "1.0.0";
  const latest = "2.0.0";
  const lines = renderUpdateBox(current, latest, { cols: 80, color: false });

  for (const line of lines) {
    expect(line).toBe(stripAnsi(line));
  }
});
