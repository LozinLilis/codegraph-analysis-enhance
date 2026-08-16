/**
 * Dependency scanner for the analysis plugin.
 *
 * Extracts a structured dependency list from common manifest files:
 *   - Cargo.toml        (Rust)
 *   - pyproject.toml    (Python)
 *   - package.json      (JavaScript/TypeScript)
 *
 * Framework-level dependencies get flagged (framework=1) using a small
 * curated table of well-known frameworks per ecosystem.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';

const FRAMEWORKS: Record<string, string[]> = {
  rust: ['tokio', 'serde', 'axum', 'actix-web', 'rocket', 'rayon', 'clap', 'anyhow', 'thiserror', 'tower', 'hyper', 'tonic', 'sqlx', 'diesel', 'tracing', 'pyo3'],
  python: ['fastapi', 'flask', 'django', 'pydantic', 'sqlalchemy', 'httpx', 'requests', 'numpy', 'pandas', 'torch', 'tensorflow', 'asyncpg', 'redis', 'celery', 'pytest', 'mypy', 'ruff', 'uvicorn'],
  js: ['react', 'vue', 'express', 'next', 'nuxt', 'svelte', 'fastify', 'axios', 'lodash', 'typescript', 'vite', 'jest', 'vitest', 'webpack', 'esbuild'],
};

/** Parse a TOML-ish dependencies section: `name = "ver"` or `name = { version = "..." }`. */
function parseTomlSection(lines: string[]): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inSection = /^\[(dependencies|dev-dependencies|build-dependencies|project\.dependencies|project\.optional-dependencies)\]/i.test(line);
      continue;
    }
    if (!inSection || line.length === 0 || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|\{.*?version\s*=\s*"([^"]+)"|\[)/);
    const depName = m?.[1] ?? '';
    if (depName && depName !== 'workspace') {
      out.push({ name: depName, version: m?.[2] ?? m?.[3] ?? '' });
    }
  }
  return out;
}

/** Extract dependencies from a manifest file by ecosystem. */
async function scanManifest(root: string, relPath: string, ecosystem: string): Promise<{ name: string; version: string; kind: string }[]> {
  const abs = path.join(root, relPath);
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf-8');
  } catch {
    return [];
  }

  const frameworkSet = new Set(FRAMEWORKS[ecosystem] ?? []);
  const out: { name: string; version: string; kind: string }[] = [];
  const flag = (name: string, version: string, kind: string) => {
    out.push({ name, version, kind });
  };

  if (relPath.endsWith('Cargo.toml')) {
    const lines = content.split(/\r?\n/);
    // find section boundaries
    const deps = parseTomlSection(lines.slice(0, lines.findIndex((l) => l.trim().startsWith('[target')) === -1 ? lines.length : lines.findIndex((l) => l.trim().startsWith('[target'))));
    for (const d of deps) flag(d.name, d.version, 'runtime');
  } else if (relPath.endsWith('pyproject.toml')) {
    const lines = content.split(/\r?\n/);
    for (const d of parseTomlSection(lines)) flag(d.name, d.version, 'runtime');
  } else if (relPath.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(content);
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) flag(name, String(version), 'runtime');
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) flag(name, String(version), 'dev');
    } catch { /* invalid json — skip */ }
  }

  for (const d of out) {
    (d as { framework?: number }).framework = frameworkSet.has(d.name) ? 1 : 0;
  }
  return out;
}

/** Recursively find manifest files (depth-limited, excludes node_modules/.git/target). */
async function findManifests(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', '__pycache__']);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (e.name === 'Cargo.toml' || e.name === 'pyproject.toml' || e.name === 'package.json') {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(root, 1);
  return out;
}

/** Refresh analysis_dependencies from all supported manifests under root. */
export async function refreshDependencies(db: SqliteDatabase, root: string): Promise<number> {
  const insert = db.prepare(`
    INSERT INTO analysis_dependencies (name, version, kind, framework, source_file, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      version=excluded.version, kind=excluded.kind, framework=excluded.framework,
      source_file=excluded.source_file, extracted_at=excluded.extracted_at
  `);

  const now = Date.now();
  let count = 0;
  const seenSources = new Set<string>();
  const manifests = await findManifests(root, 3);
  for (const rel of manifests) {
    let ecosystem: string;
    if (rel.endsWith('Cargo.toml')) ecosystem = 'rust';
    else if (rel.endsWith('pyproject.toml')) ecosystem = 'python';
    else ecosystem = 'js';
    const deps = await scanManifest(root, rel, ecosystem);
    seenSources.add(rel);
    for (const d of deps) {
      insert.run(d.name, d.version, d.kind, (d as { framework?: number }).framework ?? 0, rel, now);
      count++;
    }
  }

  // drop deps whose manifest was not scanned this run (manifest deleted/moved)
  if (seenSources.size === 0) {
    db.exec(`DELETE FROM analysis_dependencies`);
  } else {
    const placeholders = [...seenSources].map(() => '?').join(',');
    db.prepare(`DELETE FROM analysis_dependencies WHERE source_file NOT IN (${placeholders})`).run(...seenSources);
  }
  return count;
}
