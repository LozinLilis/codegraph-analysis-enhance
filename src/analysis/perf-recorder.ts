/**
 * Performance record store for the analysis plugin.
 *
 * Stores benchmark / sampling results per symbol so LLM agents can compare
 * before/after numbers and avoid re-benchmarking what was already measured.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';

export interface PerfRecord {
  qualified_name: string;
  scenario?: string;
  metric?: 'latency' | 'throughput' | 'memory';
  value: number;
  unit?: string;
  tool?: string;
  commit_sha?: string;
}

/** Insert a new performance record. */
export function recordPerf(db: SqliteDatabase, rec: PerfRecord): number {
  const r = db.prepare(`
    INSERT INTO analysis_perf_records
      (qualified_name, scenario, metric, value, unit, tool, commit_sha, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.qualified_name,
    rec.scenario ?? '',
    rec.metric ?? 'latency',
    rec.value,
    rec.unit ?? 'ms',
    rec.tool ?? 'manual',
    rec.commit_sha ?? '',
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

/** Performance records for one symbol, newest first. */
export function getPerf(db: SqliteDatabase, symbol: string, limit = 20): any[] {
  return db.prepare(`
    SELECT id, qualified_name, scenario, metric, value, unit, tool, commit_sha, recorded_at
    FROM analysis_perf_records
    WHERE qualified_name = ?
    ORDER BY recorded_at DESC LIMIT ?
  `).all(symbol, limit);
}

/** Latest perf value for a symbol (useful for baseline comparison). */
export function getLatestPerf(db: SqliteDatabase, symbol: string): any | undefined {
  return db.prepare(`
    SELECT metric, value, unit, scenario, tool, recorded_at
    FROM analysis_perf_records
    WHERE qualified_name = ?
    ORDER BY recorded_at DESC LIMIT 1
  `).get(symbol);
}
