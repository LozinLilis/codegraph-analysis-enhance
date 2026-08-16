/**
 * Dependency scanner for the analysis plugin.
 *
 * Extracts a structured dependency list from common manifest files:
 *   - Cargo.toml        (Rust)
 *   - pyproject.toml    (Python)
 *   - package.json      (JavaScript/TypeScript)
 *
 * Framework-level detection is data-driven: a dependency counts as a
 * framework when it is imported by a broad share of the project's source
 * files (threshold: max(3 files, 5% of scanned source files)). No curated
 * name lists — the project's own code decides what matters.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';

/** Count how many source files import each dependency, by language. */
async function scanImportCounts(root: string): Promise<{ counts: Map<string, number>; files: number }> {
  const counts = new Map<string, number>();
  let files = 0;
  const skipDirs = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', '__pycache__', 'tests', 'scripts']);
  const rustRe = /^\s*use\s+([A-Za-z0-9_]+)::/;
  const pyRe = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_]+)(?:\s+as\s+\w+)?)/;
  const jsRe = /(?:from\s+|require\(\s*)['"]([^'"./][^'"]*)['"]/;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipDirs.has(e.name) || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (/\.(rs|py|ts|tsx|js|jsx)$/.test(e.name)) {
        files++;
        let src: string;
        try {
          src = await fs.readFile(abs, 'utf-8');
        } catch {
          continue;
        }
        const seen = new Set<string>();
        for (const line of src.split(/\r?\n/)) {
          let m: RegExpMatchArray | null;
          if (e.name.endsWith('.rs')) {
            m = line.match(rustRe);
            const crate = m?.[1];
            if (crate && !['crate', 'self', 'super'].includes(crate)) seen.add(crate);
          } else if (e.name.endsWith('.py')) {
            m = line.match(pyRe);
            if (m) {
              const name = (m[1] ?? m[2] ?? '').split('.')[0] ?? '';
              if (name && !['.', '..'].includes(name)) seen.add(name);
            }
          } else {
            m = line.match(jsRe);
            const dep = m?.[1]?.split('/')[0] ?? '';
            if (dep) seen.add(dep);
          }
        }
        for (const dep of seen) counts.set(dep, (counts.get(dep) ?? 0) + 1);
      }
    }
  }

  // Walk the project root once (depth-limited); sub-crate manifests are
  // already covered by the same walk, so counting per-manifest dir would
  // double-count files.
  await walk(root, 0);
  return { counts, files };
}

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

/** Extract dependencies from a manifest file. */
async function scanManifest(root: string, relPath: string): Promise<{ name: string; version: string; kind: string }[]> {
  const abs = path.join(root, relPath);
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf-8');
  } catch {
    return [];
  }

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

/** Parse Cargo.lock [[package]] blocks into name -> exact version. */
async function parseCargoLock(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const abs = path.join(root, 'Cargo.lock');
  let content: string;
  try {
    content = await fs.readFile(abs, 'utf-8');
  } catch {
    return map;
  }
  const blocks = content.split(/\[\[package\]\]/);
  for (const block of blocks) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) map.set(name, version);
  }
  return map;
}

/** Collect language/toolchain versions from rust-toolchain, Cargo.toml, pyproject.toml, package.json. */
export async function scanToolchains(root: string): Promise<
  { language: string; version: string; edition: string; source_file: string }[]
> {
  const out: { language: string; version: string; edition: string; source_file: string }[] = [];
  const manifests = await findManifests(root, 3);

  // rust-toolchain.toml / rust-toolchain at any level
  async function readFirst(file: string): Promise<string | null> {
    for (const rel of manifests) {
      const dir = path.dirname(rel);
      const candidate = path.join(dir, file);
      const abs = path.join(root, candidate);
      try {
        return await fs.readFile(abs, 'utf-8');
      } catch { /* keep looking */ }
    }
    return null;
  }

  const tc = await readFirst('rust-toolchain.toml');
  if (tc) {
    const channel = tc.match(/channel\s*=\s*"([^"]+)"/)?.[1] ?? '';
    out.push({ language: 'rust', version: channel, edition: '', source_file: 'rust-toolchain.toml' });
  } else {
    const tcPlain = await readFirst('rust-toolchain');
    if (tcPlain) {
      out.push({ language: 'rust', version: tcPlain.trim(), edition: '', source_file: 'rust-toolchain' });
    }
  }

  for (const rel of manifests) {
    if (rel.endsWith('Cargo.toml')) {
      const abs = path.join(root, rel);
      let content: string;
      try { content = await fs.readFile(abs, 'utf-8'); } catch { continue; }
      const edition = content.match(/edition\s*=\s*"([^"]+)"/)?.[1] ?? '';
      const rustVersion = content.match(/rust-version\s*=\s*"([^"]+)"/)?.[1] ?? '';
      if (edition || rustVersion) {
        out.push({
          language: 'rust',
          version: rustVersion,
          edition,
          source_file: rel,
        });
      }
    } else if (rel.endsWith('pyproject.toml')) {
      const abs = path.join(root, rel);
      let content: string;
      try { content = await fs.readFile(abs, 'utf-8'); } catch { continue; }
      const requires = content.match(/requires-python\s*=\s*"([^"]+)"/)?.[1] ?? '';
      if (requires) {
        out.push({ language: 'python', version: '', edition: requires, source_file: rel });
      }
    } else if (rel.endsWith('package.json')) {
      const abs = path.join(root, rel);
      let content: string;
      try { content = await fs.readFile(abs, 'utf-8'); } catch { continue; }
      try {
        const pkg = JSON.parse(content);
        const engines = pkg.engines?.node ?? '';
        if (engines) {
          out.push({ language: 'javascript', version: '', edition: engines, source_file: rel });
        }
      } catch { /* invalid json */ }
    }
  }
  return out;
}

/** Refresh analysis_toolchains from toolchain manifests. */
export async function refreshToolchains(db: SqliteDatabase, root: string): Promise<number> {
  const upsert = db.prepare(`
    INSERT INTO analysis_toolchains (language, version, edition, source_file, extracted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(language) DO UPDATE SET
      version=excluded.version, edition=excluded.edition,
      source_file=excluded.source_file, extracted_at=excluded.extracted_at
  `);
  const now = Date.now();
  const rows = await scanToolchains(root);
  for (const r of rows) {
    upsert.run(r.language, r.version, r.edition, r.source_file, now);
  }
  return rows.length;
}

/** Refresh analysis_dependencies from all supported manifests under root. */
export async function refreshDependencies(db: SqliteDatabase, root: string): Promise<number> {
  const insert = db.prepare(`
    INSERT INTO analysis_dependencies (name, version, resolved_version, kind, framework, import_count, source_file, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      version=excluded.version, resolved_version=excluded.resolved_version,
      kind=excluded.kind, framework=excluded.framework, import_count=excluded.import_count,
      source_file=excluded.source_file, extracted_at=excluded.extracted_at
  `);

  const now = Date.now();
  const lockVersions = await parseCargoLock(root);
  let count = 0;
  const seenSources = new Set<string>();
  const manifests = await findManifests(root, 3);
  for (const rel of manifests) {
    const deps = await scanManifest(root, rel);
    seenSources.add(rel);
    for (const d of deps) {
      const resolved = lockVersions.get(d.name) ?? '';
      insert.run(d.name, d.version, resolved, d.kind, 0, 0, rel, now);
      count++;
    }
  }

  // data-driven framework flags: broad import coverage => framework-level
  const { counts: importCounts, files: scannedFiles } = await scanImportCounts(root);
  const threshold = Math.max(3, Math.ceil(scannedFiles * 0.05));
  const updateFlag = db.prepare(`
    UPDATE analysis_dependencies SET framework = ?, import_count = ?
    WHERE name = ?
  `);
  for (const [name, n] of importCounts) {
    updateFlag.run(n >= threshold ? 1 : 0, n, name);
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
