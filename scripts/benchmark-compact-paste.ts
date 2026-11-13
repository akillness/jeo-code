import { heapStats } from "bun:jsc";
import { pathToFileURL } from "node:url";
import * as current from "../src/commands/launch/input";
import type { PromptKeyFilterState } from "../src/commands/launch/input";
import { renderInputFrame } from "../src/tui/components/input-box";

// A runtime-selected, pre-change bundle lets identical workloads replay both revisions.
const source = process.env.COMPACT_PASTE_MODULE;
const implementation: typeof current = source ? await import(pathToFileURL(source).href) : current;
const { CompactPasteStore, filterPromptInputChunk, PASTE_START, PASTE_END } = implementation;
const warmups = 3;
const repeats = 9;
const payload = "0123456789 abcdefghijklmnopqrstuvwxyz 한🙂\t end\r\n".repeat(16_384);
let sink = 0;

function measure(name: string, iterations: number, run: () => void): object {
  for (let i = 0; i < warmups; i++) run();
  const runs: number[] = [];
  for (let trial = 0; trial < repeats; trial++) {
    Bun.gc(true);
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    runs.push((performance.now() - start) / iterations);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  return { name, iterations, median_ms: sorted[Math.floor(sorted.length / 2)], max_ms: sorted.at(-1), runs_ms: runs };
}

function retained(store: current.CompactPasteStore): { entries: number; utf16_units: number } {
  const values: unknown = Reflect.get(store, "pastes");
  if (!(values instanceof Map)) throw new Error("paste map unavailable for deterministic retention counters");
  let units = 0;
  for (const value of values.values()) {
    if (typeof value !== "string") throw new Error("unexpected retained paste value");
    units += value.length;
  }
  return { entries: values.size, utf16_units: units };
}

const store = new CompactPasteStore();
const marker = store.store(payload);
const draft = `before ${marker} after`;
const frameOptions = { cols: 80, cursor: draft.length, color: false, unicode: false };
const timings = [
  measure("store_long_paste", 1, () => {
    const transient = new CompactPasteStore();
    sink += transient.store(payload).length;
    transient.clear();
  }),
  measure("has_long_paste", 200, () => { sink += Number(store.has(draft)); }),
  measure("redraw_and_detect", 100, () => {
    sink += Number(store.has(draft));
    sink += renderInputFrame(draft, frameOptions).lines.length;
  }),
  measure("capture_bracketed_paste", 1, () => {
    const state: PromptKeyFilterState = { inPaste: false };
    const result = filterPromptInputChunk(`${PASTE_START}${payload}${PASTE_END}`, null, {
      loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80,
      storePaste: body => { sink += body.length; return marker; },
    }, state);
    sink += result.out.length;
  }),
  measure("capture_64k_chunks", 1, () => {
    const state: PromptKeyFilterState = { inPaste: false };
    const env = {
      loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80,
      storePaste: (body: string) => { sink += body.length; return marker; },
    };
    filterPromptInputChunk(PASTE_START, null, env, state);
    for (let offset = 0; offset < payload.length; offset += 65_536) {
      filterPromptInputChunk(payload.slice(offset, offset + 65_536), null, env, state);
    }
    sink += filterPromptInputChunk(PASTE_END, null, env, state).out.length;
  }),
  measure("capture_and_store", 1, () => {
    const state: PromptKeyFilterState = { inPaste: false };
    const transient = new CompactPasteStore();
    const result = filterPromptInputChunk(`${PASTE_START}${payload}${PASTE_END}`, null, {
      loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80,
      storePaste: body => transient.store(body),
    }, state);
    sink += result.out.length;
    transient.clear();
  }),
];

const captureMemory: object[] = [];
for (let trial = 0; trial < repeats; trial++) {
  const state: PromptKeyFilterState = { inPaste: false };
  const env = {
    loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80,
    storePaste: (body: string) => { sink += body.length; return marker; },
  };
  Bun.gc(true);
  const before = heapStats();
  filterPromptInputChunk(`${PASTE_START}${payload}`, null, env, state);
  Bun.gc(true);
  const active = heapStats();
  const bodyUnits = state.pasteBody?.length ?? 0;
  filterPromptInputChunk(PASTE_END, null, env, state);
  Bun.gc(true);
  const closed = heapStats();
  captureMemory.push({
    active_heap_delta_bytes: active.heapSize - before.heapSize,
    active_object_delta: active.objectCount - before.objectCount,
    active_body_utf16_units: bodyUnits,
    closed_body_utf16_units: state.pasteBody?.length ?? 0,
    closed_heap_delta_bytes: closed.heapSize - before.heapSize,
  });
}

const retentionStore = new CompactPasteStore();
for (let i = 0; i < 32; i++) retentionStore.store(`${i}:${payload}`);
retentionStore.has("edited draft without a paste marker");
const afterMarkerFreeProbe = retained(retentionStore);
retentionStore.clear();
const afterClear = retained(retentionStore);
console.log(JSON.stringify({
  runtime: `bun ${Bun.version}`, source: source ?? "current", warmups, repeats,
  payload_utf16_units: payload.length, timings, capture_memory: captureMemory,
  retention: { after_marker_free_probe: afterMarkerFreeProbe, after_clear: afterClear }, sink,
}, null, 2));
