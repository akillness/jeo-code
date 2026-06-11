# Phase 1 gjc-parity QA report (lane 19-QaPhase1)

Real-surface tmux + unit red-team of Phase 1. Overall: PASS, no defects.
(Captured live via LaunchTui on a real PTY; this report is the durable record —
the per-case tmux capture files were not persisted by the lane.)

## Real-surface tmux cases (5/5 PASS)
- B3 cost KNOWN: claude-sonnet-4-5, usage 200k in / 50k out → [STEP] `… $1.35` and footer `…(main ?3) · … · $1.35`; 0.6+0.75=$1.35 correct. PASS
- B3 cost UNKNOWN: ollama/qwen2.5:0.5b, same usage → grep '$' = 0; tokens only, no fabrication. PASS
- B3 (sub) marker: executor start → `[STEP] … $1.35 (sub)`; after done → `(sub)` gone. PASS
- B5 dirty flag: branch main, dirtyCount 3 → footer `(main ?3)`. PASS
- contract: alternate_on=0; no `\x1b[0J` mid-turn; no `1049` — inline main-buffer, pass-888/889 intact. PASS

## Unit red-team (4/4 suites PASS)
- test/tokenizer.test.ts        5 pass / 0 fail
- test/output-minimizer.test.ts 4 pass / 0 fail
- test/retry.test.ts            20 pass / 0 fail
- test/slash.test.ts            17 pass / 0 fail

## Adversarial (3/3 CONFIRMED)
- minimizer keeps failures+summary+diagnostics, strips passing rows only when summary-gated, leaves plain output untouched.
- cost never fabricated for unknown/local model (costForUsage → null when priceForModel null).
- dirty flag is per-turn cached (launch.ts gitDirtyCount at runTurn construction), no per-render subprocess.

Source: lane 19-QaPhase1 structured result; leader reran full inline-scrollback regression 6/6 and full suite 952/0 after the B5 + nit fixes.
