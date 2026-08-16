/**
 * Analysis plugin schema.
 *
 * The metrics tables live in the same SQLite database file as the core
 * codegraph tables but are managed entirely by this plugin (self-managed,
 * idempotent DDL). They intentionally do NOT go through the upstream
 * migrations array — the core schema version stays untouched so upstream
 * upgrades never conflict with plugin tables.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';

/**
 * Idempotent DDL for all analysis tables. Safe to run on every open;
 * CREATE TABLE IF NOT EXISTS makes it a no-op after the first run.
 */
export const ANALYSIS_DDL = `
-- 项目元信息（插件自管）
CREATE TABLE IF NOT EXISTS analysis_project_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 依赖框架清单（Cargo.toml / pyproject.toml / package.json / pom.xml）
CREATE TABLE IF NOT EXISTS analysis_dependencies (
  name TEXT PRIMARY KEY,
  version TEXT,
  kind TEXT NOT NULL DEFAULT 'runtime',       -- runtime / dev / build
  framework INTEGER NOT NULL DEFAULT 0,       -- 1 = framework-level dep
  source_file TEXT NOT NULL,
  extracted_at INTEGER NOT NULL
);

-- 文件级度量
CREATE TABLE IF NOT EXISTS analysis_file_metrics (
  file_path TEXT PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'unknown',
  loc INTEGER NOT NULL DEFAULT 0,
  code_lines INTEGER NOT NULL DEFAULT 0,
  comment_lines INTEGER NOT NULL DEFAULT 0,
  complexity INTEGER NOT NULL DEFAULT 0,
  change_count INTEGER NOT NULL DEFAULT 0,
  first_indexed_at INTEGER NOT NULL,
  last_modified_at INTEGER NOT NULL
);

-- 符号级复杂度 + 风格标签（决策输入）
CREATE TABLE IF NOT EXISTS analysis_symbol_metrics (
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'function',
  loc INTEGER NOT NULL DEFAULT 0,
  complexity INTEGER NOT NULL DEFAULT 0,      -- cyclomatic approx (numeric)
  complexity_label TEXT NOT NULL DEFAULT '',  -- big-O hint: O(1)/O(n)/O(n^2)...
  label_source TEXT NOT NULL DEFAULT 'heuristic', -- heuristic | llm
  params INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,      -- incoming calls from core edges
  style TEXT NOT NULL DEFAULT '',             -- e.g. iterators / prealloc_string / sync_mutex
  PRIMARY KEY (qualified_name, file_path)
);

-- 运行效率记录（benchmark / 采样）
CREATE TABLE IF NOT EXISTS analysis_perf_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qualified_name TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL DEFAULT 'latency',     -- latency / throughput / memory
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'ms',
  tool TEXT NOT NULL DEFAULT 'manual',        -- source tool / harness
  commit_sha TEXT NOT NULL DEFAULT '',
  recorded_at INTEGER NOT NULL
);

-- 优化历史（返工防护）
CREATE TABLE IF NOT EXISTS analysis_optimization_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL DEFAULT '',
  issue TEXT NOT NULL DEFAULT '',
  approach TEXT NOT NULL DEFAULT '',
  before_metric TEXT NOT NULL DEFAULT '',
  after_metric TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT 'kept',       -- kept / reverted / superseded
  commit_sha TEXT NOT NULL DEFAULT '',
  recorded_at INTEGER NOT NULL
);

-- 符号按复杂度/LOC 排序的便捷视图
CREATE VIEW IF NOT EXISTS analysis_hot_symbols AS
  SELECT s.qualified_name, s.file_path, s.kind, s.loc, s.complexity,
         s.call_count, s.style,
         (SELECT COUNT(*) FROM analysis_perf_records p
          WHERE p.qualified_name = s.qualified_name) AS perf_record_count,
         (SELECT COUNT(*) FROM analysis_optimization_history h
          WHERE h.qualified_name = s.qualified_name) AS history_count
  FROM analysis_symbol_metrics s;

CREATE INDEX IF NOT EXISTS idx_analysis_symbol_metrics_qn
  ON analysis_symbol_metrics(qualified_name);
CREATE INDEX IF NOT EXISTS idx_analysis_symbol_metrics_cplx
  ON analysis_symbol_metrics(complexity DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_symbol_metrics_calls
  ON analysis_symbol_metrics(call_count DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_perf_qn
  ON analysis_perf_records(qualified_name, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_history_qn
  ON analysis_optimization_history(qualified_name, recorded_at DESC);
`;

/** Ensure all analysis tables/views exist. Idempotent. */
export function ensureAnalysisSchema(db: SqliteDatabase): void {
  db.exec(ANALYSIS_DDL);
  // --- lightweight column migrations for tables created by older plugin
  // versions (CREATE TABLE IF NOT EXISTS never adds columns) --------------
  const cols = db.prepare(`PRAGMA table_info(analysis_symbol_metrics)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'complexity_label')) {
    db.exec(`ALTER TABLE analysis_symbol_metrics ADD COLUMN complexity_label TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.some((c) => c.name === 'label_source')) {
    db.exec(`ALTER TABLE analysis_symbol_metrics ADD COLUMN label_source TEXT NOT NULL DEFAULT 'heuristic'`);
  }
}
