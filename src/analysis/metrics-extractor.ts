/**
 * Metrics extractor for the analysis plugin.
 *
 * Reads the core codegraph DB (nodes/edges/files) plus the raw source files
 * on disk, and fills the analysis_* tables:
 *   - analysis_file_metrics    (per-file LOC / comment / complexity)
 *   - analysis_symbol_metrics  (per-symbol LOC / complexity / call count / style)
 *
 * Complexity is a cheap cyclomatic approximation (branch-keyword counting)
 * — good enough for ranking and hotspot detection, not an absolute measure.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';

/** Branch keywords counted for the cyclomatic approximation. */
const BRANCH_RE = /\b(if|else|for|while|match|case|catch|when)\b|\&\&|\|\|/g;

/** Lightweight style tags derived from code features (heuristic). */
function detectStyle(body: string): string {
  const tags: string[] = [];
  if (/\bwith_capacity\s*\(/.test(body)) tags.push('prealloc_string');
  if (/(\.iter\(\)|\.map\(|\.filter\(|\.fold\()/.test(body)) tags.push('iterators');
  if (/\bMutex\b/.test(body)) tags.push('sync_mutex');
  if (/\bunsafe\b/.test(body)) tags.push('unsafe_block');
  if (/\basync\b|\bawait\b/.test(body)) tags.push('async');
  if (/(\.collect\(\)|\.chain\(|\.flat_map\()/.test(body)) tags.push('iterator_chain');
  if (/\bformat!\s*\(/.test(body)) tags.push('format_macro');
  return tags.join(',');
}

interface NodeRow {
  id: number;
  kind: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  params?: number;
}

/** Count lines, code lines and comment lines of a source string. */
function countLines(src: string): { loc: number; code: number; comments: number } {
  const lines = src.split(/\r?\n/);
  let code = 0;
  let comments = 0;
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (inBlock) {
      comments++;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('--')) {
      comments++;
    } else if (line.startsWith('/*')) {
      comments++;
      if (!line.includes('*/')) inBlock = true;
    } else {
      code++;
    }
  }
  return { loc: lines.length, code, comments };
}

/** Approximate cyclomatic complexity of a code body. */
function approximateComplexity(body: string): number {
  const matches = body.match(BRANCH_RE);
  return 1 + (matches ? matches.length : 0);
}

/**
 * Big-O hint derived heuristically from loop keywords and self-recursion.
 * Loop-keyword counting is a coarse proxy; we only claim nesting when it's
 * obvious (1-2 loops). 3+ loops are reported as O(n^k) with the loop count
 * attached so the consumer can judge, instead of inventing an exponent.
 */
function detectBigO(body: string, qualifiedName: string): string {
  const loops = body.match(/\b(for|while|loop)\s*\(?/g)?.length ?? 0;
  const shortName = qualifiedName.split('::').pop() ?? qualifiedName;
  // strip the definition line so a self-call regex doesn't match the def itself
  const defRe = new RegExp(`\\b(fn|def|function)\\s+${shortName}\\s*\\(`);
  const callable = body.replace(defRe, '');
  const selfCall = new RegExp(`\\b${shortName}\\s*\\(`).test(callable);

  let label: string;
  if (loops === 0) label = 'O(1)';
  else if (loops === 1) label = 'O(n)';
  else if (loops === 2) label = 'O(n^2)';
  else label = `O(n^k) loops=${loops}`;
  if (selfCall) label += ' recursive';
  return label;
}

/** Extract a symbol's body text from source lines (1-indexed, inclusive). */
async function extractBody(
  root: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<string> {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    const content = await fs.readFile(abs, 'utf-8');
    const lines = content.split(/\r?\n/);
    return lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
  } catch {
    return '';
  }
}

/** Refresh all analysis_* metrics tables from the core DB + source files. */
export async function refreshMetrics(
  db: SqliteDatabase,
  root: string,
): Promise<{ symbols: number; files: number; skipped: number }> {
  // --- file-level metrics ---------------------------------------------------
  const fileRows = db.prepare(
    `SELECT path, language, modified_at FROM files`,
  ).all() as { path: string; language: string; modified_at: number }[];

  const upsertFile = db.prepare(`
    INSERT INTO analysis_file_metrics
      (file_path, language, loc, code_lines, comment_lines, complexity,
       first_indexed_at, last_modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      language=excluded.language, loc=excluded.loc, code_lines=excluded.code_lines,
      comment_lines=excluded.comment_lines, complexity=excluded.complexity,
      last_modified_at=excluded.last_modified_at
  `);

  const now = Date.now();
  let fileCount = 0;
  for (const f of fileRows) {
    const abs = path.isAbsolute(f.path) ? f.path : path.join(root, f.path);
    let src = '';
    try {
      src = await fs.readFile(abs, 'utf-8');
    } catch {
      continue; // deleted or unreadable file — skip
    }
    const { loc, code, comments } = countLines(src);
    upsertFile.run(f.path, f.language, loc, code, comments, approximateComplexity(src), now, f.modified_at ?? 0);
    fileCount++;
  }

  // --- symbol-level metrics ------------------------------------------------
  const symbolKinds = [
    'function', 'method', 'struct', 'trait', 'enum', 'class', 'interface',
    'type_alias', 'constant',
  ];
  const nodeRows = db.prepare(
    `SELECT id, kind, qualified_name, file_path, language, start_line, end_line
     FROM nodes WHERE kind IN (${symbolKinds.map(() => '?').join(',')})`,
  ).all(...symbolKinds) as NodeRow[];

  // incoming call counts: edges(target) where kind='calls'
  const callCounts = new Map<number, number>();
  const callRows = db.prepare(
    `SELECT target, COUNT(*) AS n FROM edges WHERE kind='calls' GROUP BY target`,
  ).all() as { target: number; n: number }[];
  for (const r of callRows) callCounts.set(r.target, r.n);

  const upsertSymbol = db.prepare(`
    INSERT INTO analysis_symbol_metrics
      (qualified_name, file_path, kind, loc, complexity, complexity_label, params, call_count, style)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(qualified_name, file_path) DO UPDATE SET
      kind=excluded.kind, loc=excluded.loc, complexity=excluded.complexity,
      complexity_label=excluded.complexity_label, params=excluded.params,
      call_count=excluded.call_count, style=excluded.style
  `);

  // Batch-read all bodies first (async I/O), then commit one transaction.
  const prepared: { row: NodeRow; body: string }[] = [];
  for (const n of nodeRows) {
    const body = await extractBody(root, n.file_path, n.start_line, n.end_line);
    prepared.push({ row: n, body });
  }

  const tx = db.transaction(() => {
    for (const { row, body } of prepared) {
      if (body === '') continue;
      const cplx = approximateComplexity(body);
      const label = detectBigO(body, row.qualified_name);
      const style = detectStyle(body);
      const loc = Math.max(0, row.end_line - row.start_line + 1);
      const calls = callCounts.get(row.id) ?? 0;
      upsertSymbol.run(row.qualified_name, row.file_path, row.kind, loc, cplx, label, row.params ?? 0, calls, style);
    }
    // remove stale symbols for files no longer indexed
    db.exec(`
      DELETE FROM analysis_symbol_metrics
      WHERE file_path NOT IN (SELECT path FROM files);
    `);
  });
  tx();

  const skipped = prepared.filter((p) => p.body === '').length;
  return { symbols: prepared.length, files: fileCount, skipped };
}
