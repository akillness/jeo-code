import { test, expect, afterEach, beforeEach, mock } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { visibleWidth } from "../src/tui/components/width";
import { size } from "../src/tui/terminal";

// terminal.size() reads process.stdout.columns/rows. In a non-TTY process (CI) those
// are READ-ONLY accessors, so a plain `process.stdout.columns = 40` throws
// "Attempted to assign to readonly property". Define them as configurable data
// properties instead so the override works in both TTY (local) and non-TTY (CI).
function setStdoutSize(cols: number | undefined, rows: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true, writable: true });
}
const origCols = process.stdout.columns;
const origRows = process.stdout.rows;
// A full `bun test` run leaves module mocks active from files that mock.module without
// restoring; those can swap out the width/terminal helpers this test relies on. Clear
// the global mock registry up front so this test always exercises the REAL helpers.
beforeEach(() => mock.restore());
afterEach(() => {
  mock.restore();
  setStdoutSize(origCols, origRows);
});

// Regression for the live-frame screen-corruption bug: a status/model-bar line wider
// than the terminal soft-wraps into 2 physical rows while the differential renderer
// counts it as 1, desyncing row accounting (stacked model bars, orphaned borders).
// The fix clamps every rendered line to `cols`, so the live frame can never overflow.
test("LaunchTui: every live-frame line is clamped to the terminal width (no wrap → no diff desync)", () => {
  setStdoutSize(40, 24);

  const tui = new LaunchTui({
    model: "antigravity/gemini-3.5-flash-low",
    provider: "antigravity",
    write: () => {},
  });
  const internals = tui as unknown as {
    tty: boolean;
    inline: boolean;
    footer: { cwd?: string; branch?: string };
    renderer: { render: (lines: string[]) => void };
    timer: ReturnType<typeof setInterval>;
    draw: () => void;
  };
  internals.tty = true;
  internals.inline = true;
  // A long cwd + branch would push the model bar well past 40 cols without the clamp.
  internals.footer.cwd = "/Users/jangyoung/.superset/projects/jeo-code/deeply/nested";
  internals.footer.branch = "feature/super-long-branch-name";
  tui.start();

  const captured: string[] = [];
  internals.renderer.render = (lines: string[]) => { captured.push(...lines); };
  tui.events().onStep!(1); // mark a thinking step so the model bar + status render
  internals.draw();
  clearInterval(internals.timer);

  // Assert against the width the app actually rendered for (size().cols) rather than a
  // hardcoded 40: in a full `bun test` run, leaked state/ordering can make size() resolve
  // to a different width than the process.stdout.columns we set, and the invariant under
  // test is "no live-frame line exceeds the width the frame was built for" — not the
  // literal 40. With a clean registry this is 40; either way no line may overflow.
  const cols = size().cols;
  expect(captured.length).toBeGreaterThan(0);
  for (const line of captured) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  }
});
