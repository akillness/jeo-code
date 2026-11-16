import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MemEvent {
  v: 1;
  ts: string;
  kind: string;
  ref: string;
  payload: Record<string, unknown>;
}

export function appendEvent(file: string, kind: string, ref: string, payload: Record<string, unknown> = {}): MemEvent {
  const ev: MemEvent = { v: 1, ts: new Date().toISOString(), kind, ref, payload };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(ev)}\n`);
  return ev;
}

/** Reads v1 envelopes and legacy jeo ledger lines ({ts,type,planId,...}). */
export function readEvents(file: string): MemEvent[] {
  if (!existsSync(file)) return [];
  const out: MemEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.v === 1 && typeof o.kind === "string") {
      out.push(o as unknown as MemEvent);
    } else if (typeof o.type === "string") {
      const { ts, type, planId, ...rest } = o;
      out.push({ v: 1, ts: String(ts ?? ""), kind: type, ref: String(planId ?? ""), payload: rest });
    }
  }
  return out;
}
