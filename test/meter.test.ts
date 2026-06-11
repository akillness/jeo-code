import { test, expect } from "bun:test";
import { meter, stepMeter } from "../src/tui/components/meter";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("meter: renders filled/empty bar + percent, clamps", () => {
  expect(stripAnsi(meter(0, 1, 10))).toBe("[..........] 0%");
  expect(stripAnsi(meter(1, 1, 10))).toBe("[\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588] 100%");
  expect(stripAnsi(meter(0.5, 1, 10))).toBe("[=====-----] 50%");
  expect(stripAnsi(meter(2, 1, 10))).toBe("[\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588] 100%"); // clamp over
  expect(stripAnsi(meter(-1, 1, 10))).toBe("[..........] 0%"); // clamp under
  expect(stripAnsi(meter(5, 0, 10))).toBe("[..........] 0%"); // max<=0 guard
});

test("stepMeter: counter + bar", () => {
  expect(stripAnsi(stepMeter(3, 10, 10))).toBe("3/10 [xxx       ] 30%");
});
