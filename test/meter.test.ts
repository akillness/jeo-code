import { test, expect } from "bun:test";
import { meter, stepMeter } from "../src/tui/components/meter";

// chalk is disabled under bun:test (non-TTY → level 0), so glyphs render plain.

test("meter: evolutionary glyphs by stage + percent, with clamping", () => {
  // ratio 0 → stage 0 (o / .)
  expect(meter(0, 1, 10)).toBe("[..........] 0%");
  // ratio 1 → stage 4 (█ / ░)
  expect(meter(1, 1, 10)).toBe("[\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588] 100%");
  // ratio 0.5 → stage 2 (= / -)
  expect(meter(0.5, 1, 10)).toBe("[=====-----] 50%");
  // clamp over → ratio 1 → stage 4
  expect(meter(2, 1, 10)).toBe("[\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588] 100%");
  // clamp under → ratio 0 → stage 0
  expect(meter(-1, 1, 10)).toBe("[..........] 0%");
  // max<=0 guard → ratio 0 → stage 0
  expect(meter(5, 0, 10)).toBe("[..........] 0%");
});

test("meter: width<=0 produces an empty bar without throwing", () => {
  expect(meter(0.5, 1, 0)).toBe("[] 50%");
});

test("stepMeter: counter + evolutionary bar", () => {
  // ratio 0.3 → stage 1 (x / space)
  expect(stepMeter(3, 10, 10)).toBe("3/10 [xxx       ] 30%");
});

test("stepMeter: non-positive total is guarded (no NaN/divide-by-zero)", () => {
  expect(stepMeter(0, 0, 10)).toBe("0/0 [..........] 0%");
});
