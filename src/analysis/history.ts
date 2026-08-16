/**
 * Optimization history store for the analysis plugin.
 *
 * Every time a symbol is optimized (or an optimization is reverted),
 * record it here so future sessions can check "was this tried before,
 * with what approach and what result?" — preventing repeated analysis
 * and repeated failed attempts.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';

export interface OptimizationRecord {
  qualified_name: string;
  file_path?: string;
  issue?: string;
  approach?: string;
  before_metric?: string;
  after_metric?: string;
  verdict?: 'kept' | 'reverted' | 'superseded';
  commit_sha?: string;
}

/** Insert a new optimization-history record. */
export function recordOptimization(db: SqliteDatabase, rec: OptimizationRecord): number {
  const r = db.prepare(`
    INSERT INTO analysis_optimization_history
      (qualified_name, file_path, issue, approach, before_metric, after_metric,
       verdict, commit_sha, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.qualified_name,
    rec.file_path ?? '',
    rec.issue ?? '',
    rec.approach ?? '',
    rec.before_metric ?? '',
    rec.after_metric ?? '',
    rec.verdict ?? 'kept',
    rec.commit_sha ?? '',
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

/** Full history for one symbol, newest first. */
export function getHistory(db: SqliteDatabase, symbol: string): any[] {
  return db.prepare(`
    SELECT id, qualified_name, file_path, issue, approach, before_metric,
           after_metric, verdict, commit_sha, recorded_at
    FROM analysis_optimization_history
    WHERE qualified_name = ?
    ORDER BY recorded_at DESC
  `).all(symbol);
}

/** Recent history across the project (limit newest N). */
export function listRecentHistory(db: SqliteDatabase, limit: number): any[] {
  return db.prepare(`
    SELECT id, qualified_name, file_path, issue, approach, before_metric,
           after_metric, verdict, commit_sha, recorded_at
    FROM analysis_optimization_history
    ORDER BY recorded_at DESC LIMIT ?
  `).all(limit);
}
