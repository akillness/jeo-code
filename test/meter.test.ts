import { test, expect } from "bun:test";
import { meter, stepMeter } from "../src/tui/components/meter";

test("meter: renders filled/empty bar + percent, clamps", () => {
  expect(meter(0, 1, 10)).toBe("[----------] 0%");
  expect(meter(1, 1, 10)).toBe("[##########] 100%");
  expect(meter(0.5, 1, 10)).toBe("[#####-----] 50%");
  expect(meter(2, 1, 10)).toBe("[##########] 100%"); // clamp over
  expect(meter(-1, 1, 10)).toBe("[----------] 0%"); // clamp under
  expect(meter(5, 0, 10)).toBe("[----------] 0%"); // max<=0 guard
});

test("stepMeter: counter + bar", () => {
  expect(stepMeter(3, 10, 10)).toBe("3/10 [###-------] 30%");
});
