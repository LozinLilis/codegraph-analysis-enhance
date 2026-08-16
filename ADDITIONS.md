# ADDITIONS — Analysis Plugin (this fork)

This fork keeps the upstream codegraph intact and adds an **analysis plugin**
(`src/analysis/`) that turns the codegraph DB into a decision-support
database for performance work. The core is untouched except a two-line CLI
registration, so upstream merges stay conflict-free.

## What it adds

| Capability | Description |
|---|---|
| Per-symbol metrics | cyclomatic complexity (numeric) + big-O hint label, LOC, style tags, incoming call counts |
| LLM complexity classification | real big-O verdicts (O(log n), O(n log n), O(n·m)...) via any OpenAI-compatible model — heuristics can't express these |
| Optimization history | ledger of what was tried, with what approach and result (kept / reverted / superseded) — prevents rework |
| Performance records | benchmark / sampling results per symbol with before/after comparison |
| Locked dependency versions | declared version + exact locked version from Cargo.lock |
| Toolchain info | rust channel/edition, python requires-python, node engines |
| Data-driven framework flags | a dependency is framework-level when broadly imported by the project's own source (no curated name lists) |
| Token accounting | every LLM analysis run reports input/output/total tokens, so maintenance cost is measurable |

## Commands

```
codegraph analysis refresh [path]          # recompute all metrics (zero LLM cost)
codegraph analysis metrics <symbol>        # complexity/LOC/calls/style + latest perf
codegraph analysis hot [path] --limit N    # rank hotspots by complexity or calls
codegraph analysis deps [path]             # dependencies with locked versions + import counts
codegraph analysis toolchain [path]        # language/toolchain versions
codegraph analysis context <symbol>        # LLM decision view: metrics + perf + history
codegraph analysis analyze <symbol>        # LLM-classify one symbol's time complexity
codegraph analysis analyze-hot --limit N   # LLM-classify top-N hotspots (cost-controlled)
codegraph analysis history <symbol>        # optimization history for a symbol
codegraph analysis record-history <symbol> # append an optimization-history record
codegraph analysis bench record|list <sym> # append / show performance records
```

## Decision workflow

When optimizing or refactoring a symbol:

```
1. READ    analysis context <symbol>   — complexity, big-O, style, calls, history
2. JUDGE   heuristic label?            → analysis analyze for a real big-O verdict
           history verdict=kept?       → don't re-touch
           history verdict=reverted?   → avoid that approach
           no perf baseline?           → measure first, then change
3. CHOOSE  match style tags of sibling functions; prefer validated approaches
4. CHANGE + VERIFY  targeted tests; measure before/after
5. RECORD  record-history + bench record
```

## LLM configuration

OpenAI-compatible endpoint via environment variables:

```
CODEGRAPH_LLM_BASE_URL   (default https://api.openai.com/v1)
CODEGRAPH_LLM_API_KEY    (required for analyze / analyze-hot)
CODEGRAPH_LLM_MODEL      (default gpt-4o-mini)
```

Measured cost: ~1.3k tokens per classified symbol with a typical chat model;
`refresh` and all read commands cost zero LLM tokens. Batch mode only touches
heuristic-labeled symbols and caps at 200.

## Design notes

- All analysis data lives in the same `codegraph.db` (`analysis_*` tables),
  managed with idempotent DDL — the upstream migrations array is untouched.
- Plugin code lives entirely in `src/analysis/`; the only upstream change is
  `registerAnalysisCommands(program)` in `src/bin/codegraph.ts`.
- Companion skill: `.claude/skills/codegraph-analysis/SKILL.md`.
