# Analysis Plugin

The `analysis` plugin turns the codegraph DB into a decision-support
database for performance work: per-symbol complexity (numeric + big-O
label), LOC, style tags, incoming call counts, locked dependency versions,
toolchain info, benchmark records, and an optimization-history ledger that
prevents rework. All data lives in the same `codegraph.db` as the core
tables (`analysis_*`), managed idempotently — the upstream schema and
migrations are never touched.

The core is untouched except a two-line CLI registration
(`registerAnalysisCommands(program)` in `src/bin/codegraph.ts`), so
upstream merges stay conflict-free.

## Installing

Requirements: Node ≥ 22.5 (node:sqlite). No native build step.

```bash
# from the repository root
npm install --include=dev
npm run build
npm link                 # optional: global `codegraph` command
```

Quick start on any project:

```bash
codegraph init <project-path>                       # index (no LLM)
codegraph analysis refresh <project-path>           # metrics/deps/toolchains (zero LLM cost)
codegraph analysis hot <project-path> --limit 10    # hotspot ranking
codegraph analysis context <symbol> <project-path>  # decision view before optimizing

# optional: LLM complexity classification (any OpenAI-compatible endpoint)
export CODEGRAPH_LLM_BASE_URL=...
export CODEGRAPH_LLM_API_KEY=...
export CODEGRAPH_LLM_MODEL=...
codegraph analysis analyze-hot <project-path> --limit 10
```

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

## Design notes

- **Data-driven framework flags**: a dependency is framework-level when it
  is imported by a broad share of the project's own source (threshold:
  max(3 files, 5% of scanned files)). No curated name lists.
- **LLM classification** stores `complexity_label` with
  `label_source='llm'`; the heuristic label stays as fallback. Batch mode
  only touches heuristic-labeled symbols and caps at 200.
- **Token accounting**: every LLM run reports input/output/total tokens —
  see [benchmark.md](benchmark.md) for measured costs (~1.3k tokens per
  classified symbol; all read commands are zero-cost).

## Companion skill

`.claude/skills/codegraph-analysis/SKILL.md` documents the same workflow
for agents working in this repository.
