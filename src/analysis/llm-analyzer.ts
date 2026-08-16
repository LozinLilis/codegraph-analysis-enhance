/**
 * LLM-based complexity analysis for the analysis plugin.
 *
 * Heuristic big-O hints (loop counting) cannot express O(log n), O(n log n),
 * O(n*m) or other real-world classes — so for symbols where precision matters
 * we ask an LLM to classify the source and store its verdict with a
 * `label_source = 'llm'` marker.
 *
 * The LLM endpoint is OpenAI-compatible and configured via environment:
 *   CODEGRAPH_LLM_BASE_URL  (default: https://api.openai.com/v1)
 *   CODEGRAPH_LLM_API_KEY   (required)
 *   CODEGRAPH_LLM_MODEL     (default: gpt-4o-mini)
 *
 * Cost control: batch mode only analyzes the top-N hottest/most complex
 * symbols unless the user explicitly asks for everything.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function readLlmConfig(): LlmConfig | null {
  const apiKey = process.env.CODEGRAPH_LLM_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: process.env.CODEGRAPH_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey,
    model: process.env.CODEGRAPH_LLM_MODEL ?? 'gpt-4o-mini',
  };
}

export interface LlmVerdict {
  complexity: string; // e.g. O(n log n)
  reason: string;
}

const SYSTEM_PROMPT = `You are a precise algorithm-complexity analyst. Given a source function,
classify its time complexity. Consider nested loops, recursion, sorting,
hash lookups, binary search, and standard-library calls you can see.

Return ONLY JSON with exactly two fields:
{"complexity": "O(...)", "reason": "<one short sentence in the same language as the request>"}

Rules:
- Use canonical big-O forms: O(1), O(log n), O(n), O(n log n), O(n^2), O(n*m), O(2^n)...
- If complexity depends on two independent sizes, use O(n*m) with names in reason.
- Never answer with code or markdown fences.`;

function buildUserPrompt(language: string, qualifiedName: string, body: string): string {
  return `Language: ${language}\nFunction: ${qualifiedName}\n\nSource:\n\`\`\`\n${body.slice(0, 6000)}\n\`\`\`\n\nComplexity:`;
}

/** Call the LLM once and parse the verdict. Throws on transport/parse errors. */
export async function analyzeSymbolWithLlm(
  cfg: LlmConfig,
  language: string,
  qualifiedName: string,
  body: string,
): Promise<LlmVerdict> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(language, qualifiedName, body) },
      ],
      temperature: 0,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`LLM returned non-JSON: ${content.slice(0, 120)}`);
  const parsed = JSON.parse(m[0]) as Partial<LlmVerdict>;
  const complexity = (parsed.complexity ?? '').trim();
  if (!complexity) throw new Error(`LLM returned no complexity field`);
  return { complexity, reason: (parsed.reason ?? '').trim() };
}

/** Analyze a single symbol already present in analysis_symbol_metrics. */
export async function analyzeSymbol(
  db: SqliteDatabase,
  cfg: LlmConfig,
  qualifiedName: string,
  filePath: string,
  language: string,
  body: string,
): Promise<LlmVerdict> {
  const verdict = await analyzeSymbolWithLlm(cfg, language, qualifiedName, body);
  db.prepare(`
    UPDATE analysis_symbol_metrics
    SET complexity_label = ?, label_source = 'llm'
    WHERE qualified_name = ? AND file_path = ?
  `).run(verdict.complexity, qualifiedName, filePath);
  return verdict;
}

export interface AnalyzeBatchResult {
  analyzed: number;
  failed: string[];
  skipped_no_llm: boolean;
}

/**
 * Analyze the top-N symbols (by complexity or call count). Only touches
 * symbols whose label is still heuristic — already-LLM-analyzed rows stay.
 */
export async function analyzeTopSymbols(
  db: SqliteDatabase,
  cfg: LlmConfig | null,
  limit: number,
  order: 'complexity' | 'calls',
  bodies: Map<string, { body: string; language: string; filePath: string }>,
): Promise<AnalyzeBatchResult> {
  if (!cfg) {
    return { analyzed: 0, failed: [], skipped_no_llm: true };
  }
  const sortCol = order === 'calls' ? 'call_count' : 'complexity';
  const rows = db.prepare(`
    SELECT qualified_name, file_path FROM analysis_symbol_metrics
    WHERE label_source = 'heuristic'
    ORDER BY ${sortCol} DESC LIMIT ?
  `).all(limit) as { qualified_name: string; file_path: string }[];

  const failed: string[] = [];
  let analyzed = 0;
  for (const r of rows) {
    const src = bodies.get(r.qualified_name);
    if (!src || !src.body) {
      failed.push(`${r.qualified_name} (source unreadable)`);
      continue;
    }
    try {
      const verdict = await analyzeSymbolWithLlm(cfg, src.language, r.qualified_name, src.body);
      db.prepare(`
        UPDATE analysis_symbol_metrics
        SET complexity_label = ?, label_source = 'llm'
        WHERE qualified_name = ? AND file_path = ?
      `).run(verdict.complexity, r.qualified_name, r.file_path);
      analyzed++;
    } catch (err) {
      failed.push(`${r.qualified_name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { analyzed, failed, skipped_no_llm: false };
}
