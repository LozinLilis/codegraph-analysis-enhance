/**
 * CLI command registration for the analysis plugin.
 *
 * Adds a `codegraph analysis` command tree:
 *   refresh          recompute all metrics from the core DB + source
 *   metrics          show complexity/LOC/call-count/style for a symbol
 *   hot              show the most complex / hottest symbols
 *   deps             show the dependency list
 *   history          show optimization history for a symbol (or recent)
 *   record-history   append an optimization-history record
 *   bench record     append a performance record
 *   bench list       show performance records for a symbol
 *   context          LLM-facing decision context for a symbol
 */

import * as path from 'path';
import * as fs from 'fs';
import type { Command } from 'commander';
import { DatabaseConnection, getDatabasePath } from '../db';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { ensureAnalysisSchema } from './schema';
import { refreshMetrics, extractBody } from './metrics-extractor';
import { refreshDependencies, refreshToolchains } from './deps-scanner';
import { recordOptimization, getHistory } from './history';
import { recordPerf, getPerf, getLatestPerf } from './perf-recorder';
import { readLlmConfig, analyzeSymbol, analyzeTopSymbols } from './llm-analyzer';

/** Walk up from cwd to find the nearest initialized codegraph project. */
function resolveProjectRoot(pathArg?: string): string {
  const start = path.resolve(pathArg || process.cwd());
  let current = start;
  const root = path.parse(current).root;
  for (;;) {
    if (fs.existsSync(path.join(current, '.codegraph', 'codegraph.db'))) return current;
    if (current === root) break;
    current = path.dirname(current);
  }
  throw new Error(
    `No initialized codegraph project found from ${start} (looked for .codegraph/codegraph.db in parents). Run 'codegraph init' first.`,
  );
}

function openDb(root: string): { db: SqliteDatabase; root: string } {
  const dbPath = getDatabasePath(root);
  const conn = DatabaseConnection.open(dbPath);
  return { db: conn.getDb(), root };
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

/** Register the `analysis` command tree on a commander program. */
export function registerAnalysisCommands(program: Command): void {
  const analysis = program
    .command('analysis')
    .description('Performance & complexity analysis (plugin)');

  // -- refresh ---------------------------------------------------------------
  analysis
    .command('refresh [path]')
    .description('Recompute complexity/LOC/style/deps metrics from core DB + source')
    .action(async (pathArg?: string) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const m = await refreshMetrics(db, root);
        const deps = await refreshDependencies(db, root);
        const tcs = await refreshToolchains(db, root);
        console.log(`analysis refresh done (${root})`);
        console.log(`  symbols: ${m.symbols}  files: ${m.files}  skipped(unreadable): ${m.skipped}`);
        console.log(`  dependencies: ${deps}  toolchains: ${tcs}`);
      } finally {
        db.close();
      }
    });

  // -- metrics ---------------------------------------------------------------
  analysis
    .command('metrics <symbol> [path]')
    .description('Show complexity/LOC/call-count/style for a symbol')
    .action((symbol: string, pathArg?: string) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const rows = db.prepare(
          `SELECT qualified_name, file_path, kind, loc, complexity, complexity_label, label_source, params, call_count, style
           FROM analysis_symbol_metrics
           WHERE qualified_name = ? OR qualified_name LIKE ?`,
        ).all(symbol, `%${symbol}%`);
        if (rows.length === 0) {
          console.log(`No metrics for '${symbol}'. Run 'codegraph analysis refresh' first.`);
          return;
        }
        for (const r of rows) {
          const perf = getLatestPerf(db, r.qualified_name);
          console.log(`${r.qualified_name}  (${r.kind}, ${r.file_path})`);
          console.log(`  loc=${r.loc}  complexity=${r.complexity}${r.complexity_label ? ' (' + r.complexity_label + ')' : ''}${r.label_source === 'llm' ? ' [llm]' : ''}  params=${r.params}  calls=${r.call_count}`);
          if (r.style) console.log(`  style: ${r.style}`);
          if (perf) console.log(`  latest perf: ${perf.value}${perf.unit} (${perf.metric}${perf.scenario ? ', ' + perf.scenario : ''})`);
        }
      } finally {
        db.close();
      }
    });

  // -- hot --------------------------------------------------------------------
  analysis
    .command('hot [path]')
    .option('-n, --limit <n>', 'number of rows', '20')
    .option('--sort <key>', 'complexity | calls | loc', 'complexity')
    .description('Show the most complex / hottest symbols')
    .action((pathArg: string | undefined, opts: { limit: string; sort: string }) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const sortCol = opts.sort === 'calls' ? 'call_count' : opts.sort === 'loc' ? 'loc' : 'complexity';
        const rows = db.prepare(
          `SELECT qualified_name, kind, file_path, loc, complexity, complexity_label, label_source, call_count, style
           FROM analysis_symbol_metrics
           ORDER BY ${sortCol} DESC LIMIT ?`,
        ).all(Number(opts.limit) || 20);
        if (rows.length === 0) {
          console.log('No metrics yet. Run `codegraph analysis refresh` first.');
          return;
        }
        console.log(`Top ${rows.length} by ${opts.sort}:`);
        for (const r of rows) {
          console.log(`  ${r.complexity.toString().padStart(4)} cplx ${(r.complexity_label || '').padEnd(14)}${r.label_source === 'llm' ? '[llm]' : '     '} | ${r.call_count.toString().padStart(4)} calls | ${r.loc.toString().padStart(5)} loc | ${r.qualified_name} (${r.file_path})`);
        }
      } finally {
        db.close();
      }
    });

  // -- deps -------------------------------------------------------------------
  analysis
    .command('deps [path]')
    .description('Show extracted dependency list')
    .action((pathArg?: string) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const rows = db.prepare(
          `SELECT name, version, resolved_version, kind, framework, import_count, source_file FROM analysis_dependencies ORDER BY framework DESC, import_count DESC, name`,
        ).all() as { name: string; version: string; resolved_version: string; kind: string; framework: number; import_count: number; source_file: string }[];
        if (rows.length === 0) {
          console.log('No dependencies extracted. Run `codegraph analysis refresh` first.');
          return;
        }
        for (const r of rows) {
          const fw = r.framework ? ' [framework]' : '';
          const locked = r.resolved_version ? ` (locked ${r.resolved_version})` : '';
          console.log(`  ${r.name}${r.version ? ' ' + r.version : ''}${locked} (${r.kind}${fw}, imported by ${r.import_count} files, ${r.source_file})`);
        }
      } finally {
        db.close();
      }
    });

  // -- toolchain ----------------------------------------------------------------
  analysis
    .command('toolchain [path]')
    .description('Show language/toolchain versions (rust channel, edition, python requires, node engines)')
    .action((pathArg?: string) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const rows = db.prepare(
          `SELECT language, version, edition, source_file FROM analysis_toolchains ORDER BY language`,
        ).all() as { language: string; version: string; edition: string; source_file: string }[];
        if (rows.length === 0) {
          console.log('No toolchain info. Run `codegraph analysis refresh` first.');
          return;
        }
        for (const r of rows) {
          const v = r.version ? ` version=${r.version}` : '';
          const e = r.edition ? ` ${r.language === 'python' ? 'requires-python' : 'edition'}=${r.edition}` : '';
          console.log(`  ${r.language}${v}${e} (${r.source_file})`);
        }
      } finally {
        db.close();
      }
    });

  // -- history ----------------------------------------------------------------
  analysis
    .command('history <symbol> [path]')
    .description('Show optimization history for a symbol')
    .action((symbol: string, pathArg?: string) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const rows = getHistory(db, symbol);
        if (rows.length === 0) {
          console.log(`No optimization history for '${symbol}'.`);
          return;
        }
        for (const r of rows) {
          console.log(`[${fmtTime(r.recorded_at)}] ${r.qualified_name}  verdict=${r.verdict}${r.commit_sha ? ' @' + r.commit.slice(0, 8) : ''}`);
          if (r.issue) console.log(`  issue: ${r.issue}`);
          if (r.approach) console.log(`  approach: ${r.approach}`);
          if (r.before_metric || r.after_metric) console.log(`  effect: ${r.before_metric} -> ${r.after_metric}`);
        }
      } finally {
        db.close();
      }
    });

  analysis
    .command('record-history <symbol> [path]')
    .option('--issue <text>', 'problem that was addressed')
    .option('--approach <text>', 'approach that was taken')
    .option('--before <text>', 'before metric, e.g. "2.1ms"')
    .option('--after <text>', 'after metric, e.g. "0.9ms"')
    .option('--verdict <v>', 'kept | reverted | superseded', 'kept')
    .option('--commit <sha>', 'commit sha', '')
    .description('Append an optimization-history record')
    .action((symbol: string, pathArg: string | undefined, opts: Record<string, string>) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const id = recordOptimization(db, {
          qualified_name: symbol,
          issue: opts.issue,
          approach: opts.approach,
          before_metric: opts.before,
          after_metric: opts.after,
          verdict: (opts.verdict as 'kept' | 'reverted' | 'superseded') || 'kept',
          commit_sha: opts.commit,
        });
        console.log(`Recorded optimization history #${id} for '${symbol}' (verdict=${opts.verdict})`);
      } finally {
        db.close();
      }
    });

  // -- bench ------------------------------------------------------------------
  analysis
    .command('bench <action> <symbol> [path]')
    .option('-m, --metric <m>', 'latency | throughput | memory', 'latency')
    .option('-v, --value <n>', 'measured value (number)', '0')
    .option('-u, --unit <u>', 'unit, e.g. ms / ops/s / MB', 'ms')
    .option('-s, --scenario <s>', 'scenario / case name', '')
    .option('-t, --tool <t>', 'source tool / harness', 'manual')
    .option('-c, --commit <sha>', 'commit sha', '')
    .description('bench record|list <symbol> — append or show performance records')
    .action((action: string, symbol: string, pathArg: string | undefined, opts: Record<string, string>) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        if (action === 'record') {
          const value = Number(opts.value);
          if (!Number.isFinite(value)) {
            console.error(`Invalid --value: ${opts.value}`);
            return;
          }
          const id = recordPerf(db, {
            qualified_name: symbol,
            scenario: opts.scenario,
            metric: opts.metric as 'latency' | 'throughput' | 'memory',
            value,
            unit: opts.unit,
            tool: opts.tool,
            commit_sha: opts.commit,
          });
          console.log(`Recorded perf #${id}: ${symbol} ${value}${opts.unit} (${opts.metric}${opts.scenario ? ', ' + opts.scenario : ''})`);
        } else if (action === 'list') {
          const rows = getPerf(db, symbol);
          if (rows.length === 0) {
            console.log(`No perf records for '${symbol}'.`);
            return;
          }
          for (const r of rows) {
            console.log(`[${fmtTime(r.recorded_at)}] ${r.value}${r.unit} (${r.metric}${r.scenario ? ', ' + r.scenario : ''}, tool=${r.tool}${r.commit_sha ? ', @' + r.commit.slice(0, 8) : ''})`);
          }
        } else {
          console.error(`Unknown bench action: ${action} (use record|list)`);
        }
      } finally {
        db.close();
      }
    });

  // -- llm analyze ------------------------------------------------------------
  analysis
    .command('analyze <symbol> [path]')
    .description('LLM-classify complexity for one symbol (needs CODEGRAPH_LLM_API_KEY)')
    .action(async (symbol: string, pathArg?: string) => {
      const cfg = readLlmConfig();
      if (!cfg) {
        console.error('CODEGRAPH_LLM_API_KEY not set. Configure CODEGRAPH_LLM_BASE_URL / CODEGRAPH_LLM_API_KEY / CODEGRAPH_LLM_MODEL.');
        return;
      }
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const row = db.prepare(
          `SELECT qualified_name, file_path, language, start_line, end_line
           FROM nodes WHERE qualified_name = ? OR qualified_name LIKE ?
           LIMIT 1`,
        ).get(symbol, `%${symbol}%`) as
          { qualified_name: string; file_path: string; language: string; start_line: number; end_line: number } | undefined;
        if (!row) {
          console.log(`No node found for '${symbol}'.`);
          return;
        }
        const body = await extractBody(root, row.file_path, row.start_line, row.end_line);
        if (!body) {
          console.log(`Source unreadable for '${row.qualified_name}' at ${row.file_path}. Run 'codegraph sync' first.`);
          return;
        }
        console.log(`Analyzing ${row.qualified_name} (${row.language}) with ${cfg.model}...`);
        const verdict = await analyzeSymbol(db, cfg, row.qualified_name, row.file_path, row.language, body);
        console.log(`  complexity: ${verdict.complexity}`);
        if (verdict.reason) console.log(`  reason: ${verdict.reason}`);
        console.log(`  tokens: input ${verdict.usage.promptTokens} | output ${verdict.usage.completionTokens} | total ${verdict.usage.totalTokens}`);
      } finally {
        db.close();
      }
    });

  analysis
    .command('analyze-hot [path]')
    .option('-n, --limit <n>', 'number of symbols to analyze', '10')
    .option('--order <key>', 'complexity | calls', 'complexity')
    .description('LLM-classify the top-N heuristic-labeled symbols (cost-controlled)')
    .action(async (pathArg: string | undefined, opts: { limit: string; order: string }) => {
      const cfg = readLlmConfig();
      if (!cfg) {
        console.error('CODEGRAPH_LLM_API_KEY not set. Configure CODEGRAPH_LLM_BASE_URL / CODEGRAPH_LLM_API_KEY / CODEGRAPH_LLM_MODEL.');
        return;
      }
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 200));
        const order = opts.order === 'calls' ? 'calls' : 'complexity';

        // preload bodies for candidate symbols
        const candidates = db.prepare(
          `SELECT qualified_name, file_path, language, start_line, end_line
           FROM nodes
           WHERE qualified_name IN (
             SELECT qualified_name FROM analysis_symbol_metrics
             WHERE label_source = 'heuristic'
             ORDER BY ${order === 'calls' ? 'call_count' : 'complexity'} DESC LIMIT ?
           )`,
        ).all(limit) as
          { qualified_name: string; file_path: string; language: string; start_line: number; end_line: number }[];

        const bodies = new Map<string, { body: string; language: string; filePath: string }>();
        for (const c of candidates) {
          const body = await extractBody(root, c.file_path, c.start_line, c.end_line);
          bodies.set(c.qualified_name, { body, language: c.language, filePath: c.file_path });
        }

        const result = await analyzeTopSymbols(db, cfg, limit, order, bodies);
        if (result.skipped_no_llm) {
          console.error('CODEGRAPH_LLM_API_KEY not set.');
          return;
        }
        console.log(`Analyzed ${result.analyzed}/${limit} top-${order} symbols with ${cfg.model}`);
        console.log(`  tokens: input ${result.promptTokens} | output ${result.completionTokens} | total ${result.totalTokens} (avg ${result.analyzed > 0 ? Math.round(result.totalTokens / result.analyzed) : 0}/symbol)`);
        if (result.failed.length > 0) {
          console.log('Failed:');
          for (const f of result.failed.slice(0, 10)) console.log(`  - ${f}`);
          if (result.failed.length > 10) console.log(`  ... and ${result.failed.length - 10} more`);
        }
      } finally {
        db.close();
      }
    });

  // -- context ----------------------------------------------------------------
  analysis
    .command('context <symbol> [path]')
    .description('LLM-facing decision context: metrics + perf + history for a symbol')
    .action((symbol: string, pathArg?: string) => {
      const root = resolveProjectRoot(pathArg);
      const { db } = openDb(root);
      try {
        ensureAnalysisSchema(db);
        const syms = db.prepare(
          `SELECT qualified_name, file_path, kind, loc, complexity, complexity_label, label_source, params, call_count, style
           FROM analysis_symbol_metrics
           WHERE qualified_name = ? OR qualified_name LIKE ?`,
        ).all(symbol, `%${symbol}%`);
        if (syms.length === 0) {
          console.log(`No metrics for '${symbol}'. Run 'codegraph analysis refresh' first.`);
          return;
        }
        for (const s of syms) {
          console.log(`## ${s.qualified_name}`);
          console.log(`- kind: ${s.kind}  file: ${s.file_path}`);
          console.log(`- loc: ${s.loc}  complexity(approx): ${s.complexity}${s.complexity_label ? ' (' + s.complexity_label + ')' : ''}${s.label_source === 'llm' ? ' [llm]' : ' [heuristic]'}  params: ${s.params}  incoming calls: ${s.call_count}`);
          if (s.style) console.log(`- style: ${s.style}`);
          const perf = getPerf(db, s.qualified_name, 5);
          if (perf.length > 0) {
            console.log('- perf history:');
            for (const p of perf) console.log(`  - ${p.value}${p.unit} (${p.metric}${p.scenario ? ', ' + p.scenario : ''}) @${fmtTime(p.recorded_at)}`);
          }
          const hist = getHistory(db, s.qualified_name);
          if (hist.length > 0) {
            console.log('- optimization history:');
            for (const h of hist) console.log(`  - [${h.verdict}] ${h.approach || h.issue} ${h.before_metric}->${h.after_metric} @${fmtTime(h.recorded_at)}`);
          } else {
            console.log('- optimization history: none');
          }
        }
      } finally {
        db.close();
      }
    });
}
