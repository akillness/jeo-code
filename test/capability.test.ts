import { test, expect } from "bun:test";
import { supportsUnicode } from "../src/tui/components/capability";
import {
  EVOLUTION_SPINNER_FRAMES_ASCII,
  EVOLUTION_METER_GLYPHS_ASCII,
  spinnerFramesFor,
  meterGlyphsFor,
  evolutionTrack,
  EVOLUTION_STAGE_COUNT,
} from "../src/tui/components/evolution";
import { Spinner } from "../src/tui/components/spinner";
import { meter } from "../src/tui/components/meter";

const hasUnicode = (s: string) => /[^\x00-\x7f]/.test(s);

test("supportsUnicode: TERM dumb/linux → false; UTF locale → true", () => {
  expect(supportsUnicode({ TERM: "dumb" })).toBe(false);
  expect(supportsUnicode({ TERM: "linux" })).toBe(false);
  expect(supportsUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
  expect(supportsUnicode({ LANG: "C" })).toBe(false);
  expect(supportsUnicode({ LC_ALL: "en_US.utf8" })).toBe(true);
  expect(supportsUnicode({})).toBe(true); // no signal → assume modern
});

test("ascii fallback tables are length 5 and pure ASCII", () => {
  expect(EVOLUTION_SPINNER_FRAMES_ASCII.length).toBe(EVOLUTION_STAGE_COUNT);
  expect(EVOLUTION_METER_GLYPHS_ASCII.length).toBe(EVOLUTION_STAGE_COUNT);
  for (const set of EVOLUTION_SPINNER_FRAMES_ASCII) {
    for (const f of set) expect(hasUnicode(f)).toBe(false);
  }
  for (const g of EVOLUTION_METER_GLYPHS_ASCII) {
    expect(hasUnicode(g.fill)).toBe(false);
    expect(hasUnicode(g.empty)).toBe(false);
  }
});

test("spinnerFramesFor / meterGlyphsFor switch on unicode flag", () => {
  // The DNA stage (1) uses braille in unicode, dashes in ASCII.
  expect(spinnerFramesFor(1, true).some(hasUnicode)).toBe(true);
  expect(spinnerFramesFor(1, false).some(hasUnicode)).toBe(false);
  // Singularity meter glyph: block in unicode, '#' in ASCII.
  expect(hasUnicode(meterGlyphsFor(4, true).fill)).toBe(true);
  expect(hasUnicode(meterGlyphsFor(4, false).fill)).toBe(false);
});

test("Spinner honors the unicode:false option", () => {
  const sp = new Spinner(undefined, { unicode: false });
  sp.setStage(1);
  expect(hasUnicode(sp.current())).toBe(false);
});

test("meter / evolutionTrack ASCII mode emit no unicode", () => {
  const bar = meter(1, 1, 10, { unicode: false });
  expect(hasUnicode(bar)).toBe(false);
  const track = evolutionTrack(4, { color: false, unicode: false });
  expect(hasUnicode(track)).toBe(false);
  expect(track.startsWith("#####")).toBe(true);
  // unicode track still uses ●/○
  expect(hasUnicode(evolutionTrack(2, { color: false, unicode: true }))).toBe(true);
});
