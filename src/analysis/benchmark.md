# Benchmark — Analysis Plugin

Measured on this fork with the analysis plugin. All numbers are from real
runs on representative projects; re-run with the commands below to reproduce.

## Environment

- OS: Windows 11, Node 22 (bundled runtime)
- Core indexer: codegraph 1.5.0 source build (`npm run build`)
- LLM: a typical chat model via OpenAI-compatible endpoint (CODEGRAPH_LLM_* env)
- Projects: Project A (Rust+Python workspace, ~140 files),
  Project B (Rust TUI workspace, ~100 files)

## 1. Indexing (core, no LLM)

| Project | Files | Nodes | Edges | Init time |
|---|---|---|---|---|
| Project B | 100 | 2,339 | 7,108 | **1.2 s** |
| Project A | 138 | 2,080* | 6,713* | ~1 s |

\* Project A numbers from an earlier index version; refreshed counts vary.

## 2. Analysis refresh (plugin, zero LLM tokens)

`codegraph analysis refresh` recomputes per-symbol metrics, dependencies
(declared + locked), toolchains, and import coverage — all local.

| Project | Symbols | Files | Dependencies | Toolchains | Skipped |
|---|---|---|---|---|---|
| Project B | 1,326 | 100 | 18 | 3 | 0 |
| Project A | 1,203 | 134 | 10 | 2 | 34 (unreadable legacy paths) |

Runtime: seconds. No LLM calls, no network.

## 3. LLM complexity classification

`codegraph analysis analyze-hot` classifies top-N symbols (heuristic labels
only; already-classified rows are skipped).

| Run | Symbols | Input tokens | Output tokens | Total | Avg / symbol |
|---|---|---|---|---|---|
| Project B batch (10) | 10 | 11,986 | 481 | 12,467 | **1,247** |
| Project B batch (5, after DB rebuild) | 5 | 7,067 | 228 | 7,295 | **1,459** |
| Single symbol | 1 | 1,237 | 55 | 1,292 | 1,292 |

Cost estimate (typical chat-model pricing, ¥2/M input, ¥8/M output):

- 1 symbol ≈ ¥0.003 (about 0.3 fen / 0.04 US cent)
- 10 hotspots ≈ ¥0.03
- Full symbol set of a ~100-file project (1,300+ symbols) ≈ ¥4 — but the
  hotspot strategy (top 10–50) covers the decisions that matter for ≈¥0.15

## 4. Query cost (the payoff)

The decision workflow uses DB reads, not fresh LLM analysis:

| Query | Cost |
|---|---|
| `analysis context <symbol>` (metrics + perf + history) | ~1 file read, sub-second, **0 LLM tokens** |
| `analysis hot / deps / toolchain / history` | 0 LLM tokens |
| Traditional approach: LLM reads source + reasons every time | 5–20k tokens per decision |

Effective saving: the one-time classification (~1.3k tokens/symbol) is
amortized across every future decision; each `context` lookup costs roughly
1/10 to 1/20 of a fresh analysis.

## 5. Quality signal (why LLM labels matter)

Same symbol, two classifiers:

```
heuristic:  O(n^k) loops=6
LLM:        O(depth * (|layer| * avg_keys + |active_keys| * avg_posting))
```

And a counter-example from the TUI codebase:

```
keyboard dispatch handler   53 cplx, 43 incoming calls  →  LLM: O(1) (event dispatch)
renderer helper             29 cplx, 2 incoming calls   →  LLM: O(n*m) (rendering)
```

The heuristic flags the first as the worst hotspot; the LLM correctly says
it is a constant-time dispatch and points at the renderer instead. Numeric
complexity alone is a misleading ranking signal.

## Reproduce

```bash
npm run build
# index + analyze any project:
node dist/bin/codegraph.js init <project>
node dist/bin/codegraph.js analysis refresh <project>
CODEGRAPH_LLM_BASE_URL=... CODEGRAPH_LLM_API_KEY=... CODEGRAPH_LLM_MODEL=... \
  node dist/bin/codegraph.js analysis analyze-hot <project> --limit 10
```
