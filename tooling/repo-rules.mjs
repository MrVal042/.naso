// NASO repo rules — what the repository's people already wrote down, read and cited:
// who owns which paths, which document wins, and what each source folder is for.
//
// Nothing here is framework knowledge. CODEOWNERS, a contributing guide and a folder doc
// mean the same thing in a Go service as in an Expo app, so these work in any repository
// and say nothing in one that has none of them. Every sentence carries the file it came
// from; a rule NASO cannot cite is not written.
//
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const read = (cwd, file) => readFile(path.join(cwd, file), 'utf8').catch(() => null);

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

const CODEOWNERS_FILES = ['CODEOWNERS', '.github/CODEOWNERS', '.gitlab/CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * The CODEOWNERS file, as `{ path, entries, fallback, unmatched }`, or null.
 *
 * GitHub and GitLab read the same line format: a pattern and its owners, the last match
 * winning. GitLab's `[Section]` headers are skipped. A plain path (no glob) that matches no
 * tracked file is collected, because a rule for a folder that does not exist yet is either
 * a plan or a leftover, and an agent creating that folder should know someone owns it.
 */
export async function readCodeowners(cwd, files) {
  const file = CODEOWNERS_FILES.find((name) => files.includes(name));
  if (!file) return null;
  const text = (await read(cwd, file)) ?? '';
  const entries = [];
  let fallback = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || /^\^?\[.*\]/.test(line)) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (owners.length === 0) continue;
    if (pattern === '*' || pattern === '/*' || pattern === '**') fallback = owners;
    else entries.push({ pattern, owners });
  }
  const unmatched = entries
    .map((entry) => entry.pattern)
    .filter((pattern) => !/[*?[]/.test(pattern))
    .filter((pattern) => {
      const prefix = pattern.replace(/^\//, '').replace(/\/$/, '');
      return !files.some((f) => f === prefix || f.startsWith(`${prefix}/`) || (!pattern.startsWith('/') && f.endsWith(`/${prefix}`)));
    });
  return { path: file, entries, fallback, unmatched };
}

// ---------------------------------------------------------------------------
// Which document wins
// ---------------------------------------------------------------------------

const PRECEDENCE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'README.md'];
const PRECEDENCE_WORDS = /\b(?:wins?|takes? precedence|overrides?|outranks?|supersedes?)\b/i;
const ABOUT_DOCUMENTS = /\b(?:file|document|doc|standard|rule|guide|this|readme|agents|claude|contributing|policy)s?\b/i;

/**
 * Lines in the repository's own instruction files that say which source wins.
 *
 * Quoted with file and line, never paraphrased: a precedence rule restated in NASO's words
 * is one more document to disagree with. In AGENTS.md only the text outside the NASO block
 * counts — the block's own sentences are not the repository's rules.
 */
export async function readPrecedence(cwd, files, { start, end }) {
  const found = [];
  for (const file of PRECEDENCE_FILES.filter((name) => files.includes(name))) {
    const text = await read(cwd, file);
    if (text === null) continue;
    let fenced = false;
    let inBlock = false;
    text.split('\n').forEach((raw, index) => {
      if (raw.includes(start)) inBlock = true;
      if (raw.includes(end)) {
        inBlock = false;
        return;
      }
      if (/^\s*```/.test(raw)) fenced = !fenced;
      if (fenced || inBlock) return;
      const line = raw.replace(/^\s*(?:[-*>]|\d+\.)\s+/, '').trim();
      if (!PRECEDENCE_WORDS.test(line) || !ABOUT_DOCUMENTS.test(line) || line.length > 400) return;
      const quoted = line.replace(/`/g, '').replace(/\*\*/g, '');
      found.push({ file, line: index + 1, text: quoted.length > 220 ? `${quoted.slice(0, 217)}…` : quoted });
    });
  }
  return found.slice(0, 6);
}

// ---------------------------------------------------------------------------
// The source map
// ---------------------------------------------------------------------------

const SOURCE_ROOTS = ['src', 'lib', 'app', 'source', 'pkg', 'internal'];

/** Markdown files that may describe where code lives, layout docs first. */
function layoutDocs(files) {
  const docs = files.filter((f) => /\.mdx?$/i.test(f) && (/^docs?\//i.test(f) || !f.includes('/')) && !/^(?:AGENTS|CHANGELOG)\.md$/i.test(f));
  const rank = (f) => (/(?:folder|structure|layout|architecture|overview|codebase)/i.test(f) ? 0 : /^README/i.test(f) ? 1 : 2);
  return docs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 20);
}

/**
 * Every folder directly under the source root, with its file count and what the
 * repository's own docs say it is for.
 *
 * A purpose is taken only from a doc line that names the folder by its full path and says
 * something after it ("`src/api/` — the HTTP client"); a folder no doc describes says so,
 * rather than borrowing a meaning from its name. Two more facts come free: folders that
 * share a name at different depths (`src/auth/` beside `src/features/auth/`), which is
 * where an agent puts code in the wrong one, and folders a doc names that are not there.
 */
export async function readSourceMap(cwd, files) {
  const root = SOURCE_ROOTS.find((name) => {
    const subdirs = new Set(files.filter((f) => f.startsWith(`${name}/`) && f.split('/').length > 2).map((f) => f.split('/')[1]));
    return subdirs.size >= 2;
  });
  if (!root) return null;

  const counts = new Map();
  for (const file of files) {
    if (!file.startsWith(`${root}/`)) continue;
    const segments = file.split('/');
    if (segments.length < 3) continue;
    counts.set(segments[1], (counts.get(segments[1]) ?? 0) + 1);
  }

  const docs = [];
  for (const doc of layoutDocs(files)) {
    const text = await read(cwd, doc);
    if (text !== null) docs.push({ doc, lines: text.split('\n') });
  }

  const purposeOf = (dir) => {
    const token = `${root}/${dir}/`;
    for (const { doc, lines } of docs) {
      for (const line of lines) {
        const at = line.indexOf(token);
        if (at === -1) continue;
        const after = line
          .slice(at + token.length)
          .replace(/^`/, '')
          .replace(/^\s*(?:[—–:-]+|#)\s*/, '')
          .replace(/`/g, '')
          .replace(/\|/g, '/')
          .trim();
        if (after && /^[A-Za-z(]/.test(after)) return { text: after.length > 120 ? `${after.slice(0, 117)}…` : after, doc };
      }
    }
    return null;
  };

  const rows = [...counts.keys()].sort().map((dir) => ({ dir: `${root}/${dir}/`, files: counts.get(dir), purpose: purposeOf(dir) }));

  // Same folder name at depth one and depth two: src/auth/ and src/features/auth/.
  const depthTwo = new Map();
  for (const file of files) {
    const segments = file.split('/');
    if (segments[0] !== root || segments.length < 4) continue;
    const name = segments[2];
    if (!depthTwo.has(name)) depthTwo.set(name, new Set());
    depthTwo.get(name).add(`${root}/${segments[1]}/${name}/`);
  }
  const shared = [...counts.keys()]
    .filter((dir) => depthTwo.has(dir))
    .flatMap((dir) => [...depthTwo.get(dir)].filter((other) => other !== `${root}/${dir}/${dir}/`).map((other) => [`${root}/${dir}/`, other]))
    .slice(0, 3);

  // Folders under the root that a doc names and git does not have.
  const stale = [];
  const pathToken = new RegExp(`(?:^|[\\s\`(])(${root}/[\\w.@()[\\]-]+(?:/[\\w.@()[\\]-]+)*/)`, 'g');
  for (const { doc, lines } of docs) {
    for (const line of lines) {
      for (const match of line.matchAll(pathToken)) {
        const dir = match[1];
        if (files.some((f) => f.startsWith(dir))) continue;
        if (!stale.some((entry) => entry.dir === dir)) stale.push({ dir, doc });
      }
    }
  }

  return { root, rows: rows.slice(0, 30), more: Math.max(0, rows.length - 30), shared, stale: stale.slice(0, 5) };
}
