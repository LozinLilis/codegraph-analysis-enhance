---
name: codegraph-analysis
description: Use the analysis plugin for performance decisions — query complexity/perf/optimization history before touching code, let an LLM classify real big-O, and record outcomes. Use when the user asks to optimize, speed up, refactor a symbol, check what's slow/complex, or maintain the analysis database.
---

# CodeGraph Analysis Plugin

The analysis plugin (`src/analysis/`) turns the codegraph DB into a
decision-support database: per-symbol complexity (numeric + big-O label),
LOC, style tags, incoming call counts, locked dependency versions, toolchain
info, benchmark records, and an optimization-history ledger that prevents
rework. All data lives in the same `codegraph.db` as the core tables
(`analysis_*`), managed idempotently — upstream schema is never touched.

## Prerequisites

- Run from the codegraph repo root. Build first: `npm run build`.
- The plugin CLI is `node dist/bin/codegraph.js analysis ...` (or `codegraph
  analysis ...` when installed/linked).
- LLM classification needs an OpenAI-compatible endpoint:
  `CODEGRAPH_LLM_BASE_URL` / `CODEGRAPH_LLM_API_KEY` / `CODEGRAPH_LLM_MODEL`.

## Decision workflow (when optimizing / refactoring a symbol)

```
1. READ      analysis context <symbol>   — complexity, big-O, style, calls,
                                           perf history, optimization history
2. JUDGE     heuristic label?            → analysis analyze <symbol> for a
                                           real big-O verdict from the LLM
             history verdict=kept?       → don't re-touch; look elsewhere
             history verdict=reverted?   → avoid that approach; try another
             no perf baseline?           → measure first, then change
3. CHOOSE    match style tags of sibling functions in the same file;
             prefer approaches already validated in optimization_history
4. CHANGE + VERIFY  targeted tests; measure before/after
5. RECORD    analysis record-history <symbol> --issue ... --approach ...
             --before ... --after ... --verdict kept|reverted
             analysis bench record <symbol> --value ... --unit ms ...
```

## Command reference

| Command | Purpose |
|---|---|
| `analysis refresh [path]` | Recompute all metrics from core DB + source (symbols, files, deps, toolchains). Zero LLM cost. |
| `analysis metrics <symbol> [path]` | Complexity/LOC/calls/style + latest perf for a symbol. |
| `analysis hot [path] --limit N --sort complexity\|calls` | Rank hotspots. |
| `analysis deps [path]` | Dependency list with declared + locked versions, framework flags. |
| `analysis toolchain [path]` | Language/toolchain versions (rust channel/edition, python requires, node engines). |
| `analysis history <symbol> [path]` | Optimization history (what was tried, effect, verdict). |
| `analysis record-history <symbol> --issue ... --approach ... --before ... --after ... --verdict ...` | Append an optimization-history record. |
| `analysis bench record\|list <symbol> [path]` | Append / show performance records. |
| `analysis analyze <symbol> [path]` | LLM-classify one symbol's time complexity (stores label, source=llm). |
| `analysis analyze-hot [path] --limit N --order complexity\|calls` | LLM-classify top-N heuristic-labeled symbols. |
| `analysis context <symbol> [path]` | LLM-facing decision view: metrics + perf + history in one shot. |

## Cost discipline

- `refresh`, `metrics`, `hot`, `deps`, `toolchain`, `context`, `history` are
  pure DB reads — zero LLM cost. Query the DB, never re-scan source.
- LLM classification costs ~1.3k tokens/symbol (measured with a typical
  chat model). Batch mode only touches `label_source = 'heuristic'` rows and
  defaults to top-10; hard cap 200. Already-classified symbols are skipped.
- Every analyze run reports input/output/total tokens — if a single symbol
  exceeds ~2k tokens, the prompt or source slicing should be revisited.
- Before optimizing, always `analysis context` first: the database exists to
  prevent re-analyzing what was already measured.

## House rules

- Never commit, push, publish, or tag without the user's confirmation; leave
  all changes for review.
- Demo/benchmark data written into a real project's DB must be cleaned up or
  clearly marked; never leave fabricated perf/history records behind.
- The plugin never modifies upstream files (only `src/bin/codegraph.ts` has a
  two-line registration); keep it that way so upstream merges stay clean.
