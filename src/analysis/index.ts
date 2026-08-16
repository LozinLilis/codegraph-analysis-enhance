/**
 * Analysis plugin entry point.
 *
 * The plugin is injected into the CLI with a single registration call in
 * `src/bin/codegraph.ts`. Everything else lives in this directory, so the
 * upstream codebase stays untouched and upstream merges stay conflict-free.
 */

export { registerAnalysisCommands } from './commands';
export { ensureAnalysisSchema, ANALYSIS_DDL } from './schema';
export { refreshMetrics } from './metrics-extractor';
export { refreshDependencies } from './deps-scanner';
export { recordOptimization, getHistory, listRecentHistory } from './history';
export { recordPerf, getPerf, getLatestPerf } from './perf-recorder';
