import { test, expect, describe } from "bun:test";
import { decideStep, isConverged } from "../src/autopilot";

describe("decideStep — gate goal", () => {
  test("keeps when the eval passes, reverts when it fails", () => {
    expect(decideStep("gate", NaN, true, undefined)).toBe("keep");
    expect(decideStep("gate", NaN, false, undefined)).toBe("revert");
  });

  test("ignores score entirely for the gate decision", () => {
    // A passing gate keeps even with a 'worse' score; score is irrelevant.
    expect(decideStep("gate", 999, true, 0)).toBe("keep");
    expect(decideStep("gate", 0, false, 999)).toBe("revert");
  });
});

describe("decideStep — min goal", () => {
  test("first measurable score is always kept (no prior best)", () => {
    expect(decideStep("min", 10, true, undefined)).toBe("keep");
  });

  test("keeps a lower score, reverts an equal or higher one", () => {
    expect(decideStep("min", 8, true, 10)).toBe("keep");
    expect(decideStep("min", 10, true, 10)).toBe("revert");
    expect(decideStep("min", 12, true, 10)).toBe("revert");
  });

  test("a non-measurable (NaN) score can never prove improvement -> revert", () => {
    expect(decideStep("min", NaN, true, 10)).toBe("revert");
    expect(decideStep("min", NaN, true, undefined)).toBe("revert");
  });
});

describe("decideStep — max goal", () => {
  test("keeps a higher score, reverts an equal or lower one", () => {
    expect(decideStep("max", 12, true, 10)).toBe("keep");
    expect(decideStep("max", 10, true, 10)).toBe("revert");
    expect(decideStep("max", 8, true, 10)).toBe("revert");
  });

  test("first measurable score is kept; NaN reverts", () => {
    expect(decideStep("max", 5, true, undefined)).toBe("keep");
    expect(decideStep("max", NaN, true, 10)).toBe("revert");
  });
});

describe("isConverged — stop discipline", () => {
  test("converges once the no-progress streak reaches patience", () => {
    expect(isConverged(2, 3)).toBe(false);
    expect(isConverged(3, 3)).toBe(true);
    expect(isConverged(4, 3)).toBe(true);
  });

  test("applies to every goal — a failing gate loop must stop early, not burn max", () => {
    // Regression: gate convergence was previously disabled, so a gate goal that
    // could never pass burned the entire iteration budget. patience now bites.
    let sinceImprove = 0;
    let stoppedAt = -1;
    for (let i = 1; i <= 10; i++) {
      const decision = decideStep("gate", NaN, /*passed*/ false, undefined);
      sinceImprove = decision === "keep" ? 0 : sinceImprove + 1;
      if (isConverged(sinceImprove, 3)) {
        stoppedAt = i;
        break;
      }
    }
    expect(stoppedAt).toBe(3);
  });

  test("a passing gate resets the streak and never converges", () => {
    let sinceImprove = 0;
    for (let i = 1; i <= 5; i++) {
      const decision = decideStep("gate", NaN, /*passed*/ true, undefined);
      sinceImprove = decision === "keep" ? 0 : sinceImprove + 1;
      expect(isConverged(sinceImprove, 2)).toBe(false);
    }
  });
});

describe("ratchet streak — min goal end to end (pure)", () => {
  test("keep resets the streak, revert extends it toward convergence", () => {
    const scores = [8, 9, 7, 7.5, 7.6]; // baseline best = 10
    let best: number | undefined = 10;
    let sinceImprove = 0;
    const decisions: string[] = [];
    for (const sc of scores) {
      const decision = decideStep("min", sc, true, best);
      decisions.push(decision);
      if (decision === "keep") {
        best = sc;
        sinceImprove = 0;
      } else {
        sinceImprove += 1;
      }
    }
    expect(decisions).toEqual(["keep", "revert", "keep", "revert", "revert"]);
    expect(best).toBe(7);
    expect(sinceImprove).toBe(2);
    expect(isConverged(sinceImprove, 3)).toBe(false);
  });
});

import { foldBest } from "../src/autopilot";

describe("foldBest — in-memory best folding matches a fresh log re-scan", () => {
  test("min goal keeps the running minimum across kept steps", () => {
    let best: number | undefined = 10;
    best = foldBest("min", best, 8); // keep (improves)
    expect(best).toBe(8);
    best = foldBest("min", best, 7); // keep (improves)
    expect(best).toBe(7);
    // A higher (worse) measurable score never lowers the running min.
    best = foldBest("min", best, 9);
    expect(best).toBe(7);
  });

  test("max goal keeps the running maximum across kept steps", () => {
    let best: number | undefined = 1;
    best = foldBest("max", best, 4);
    expect(best).toBe(4);
    best = foldBest("max", best, 2); // lower score never raises the running max
    expect(best).toBe(4);
  });

  test("gate goal tracks the last kept value, not an extremum", () => {
    let best: number | undefined = 5;
    best = foldBest("gate", best, 2);
    expect(best).toBe(2); // gate ignores ordering; last kept score wins
    best = foldBest("gate", best, 9);
    expect(best).toBe(9);
  });

  test("a NaN score never becomes the best, for every goal", () => {
    expect(foldBest("min", 7, NaN)).toBe(7);
    expect(foldBest("max", 7, NaN)).toBe(7);
    expect(foldBest("gate", 7, NaN)).toBe(7);
    // First-ever measurable score seeds best even from undefined.
    expect(foldBest("min", undefined, 3)).toBe(3);
    // …but a NaN against an empty best stays empty (nothing measurable yet).
    expect(foldBest("min", undefined, NaN)).toBeUndefined();
  });

  test("the running fold equals the score the same kept sequence would log", () => {
    // Replays a min-goal kept sequence both ways: a manual `best = sc` on keep
    // (what cmdLoop did via per-iteration currentBest) and the foldBest path.
    const keptScores = [9, 7, 5];
    let manual: number | undefined = 10;
    let folded: number | undefined = 10;
    for (const sc of keptScores) {
      manual = sc; // keep => prior code set best directly to the improving score
      folded = foldBest("min", folded, sc);
    }
    expect(folded).toBe(manual);
    expect(folded).toBe(5);
  });
});
