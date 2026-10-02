#!/usr/bin/env node
// NASO Briefing — the repository scanner, the AGENTS.md writer, and the checker
// that keeps those two honest.
//
// Three views of one scan:
//
//   create   read the repository, then write AGENTS.md from nothing but what was
//            read. Every path in the output is verified to exist as it is
//            written; every sentence is either a count, a config value, or a
//            path. No placeholders, no descriptions invented from a directory's
//            name, no section kept alive only to look thorough.
//   check    does the briefing still match the repository?
//   (default = check)
//
// The rule that shapes all of it: **state only what you can read off disk.** A
// section that cannot be derived is left out rather than filled with a guess.
// That is what makes `check` able to pass on a freshly generated file with no
// human editing anything — which is the entire point, because a briefing full
// of TODO markers is a chore nobody finishes, and an unfinished briefing is
// worse than no briefing at all.
//
// Usage:
//   npx naso-dev briefing [dir]              # check (exit 1 on problems)
//   npx naso-dev briefing [dir] create       # write the NASO block
//   npx naso-dev briefing [dir] refresh      # move the version stamp only
//
// Zero external dependencies — Node.js core modules only.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  readJSONFile,
  parseArgs,
  run,
  coversUnit,
  isRootNoise,
  isNoisyDir,
  escapeRegExp,
  compareVersions,
  isMainModule,
  toolVersion,
  actorIdentity,
  banner,
  section,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { withLock } from './lock.mjs';
import { readConfig, configuredExclusions, normalizeExclusions, isExcluded } from './vendor.mjs';

const AGENTS_FILE = 'AGENTS.md';

/** The briefing file's name, for modules that report on it. */
export { AGENTS_FILE };

/**
 * The two markers that delimit everything NASO owns inside AGENTS.md.
 *
 * Exported rather than re-declared per module because `setup`, `refresh` and the
 * pre-commit append all have to agree on them exactly: a marker spelled two ways is an
 * append that lands outside the block and a refresh that rewrites somebody's prose.
 */
export const NASO_START = '<!-- naso:start -->';
export const NASO_END = '<!-- naso:end -->';

const TEMPLATE_HEADER = `<!-- naso-briefing -->
<!-- version: __VERSION__ -->
<!-- generated-by: __ACTOR__ -->
<!-- generated-at: __DATE__ -->`;

const AUTO_START = '<!-- naso:auto:start -->';
const AUTO_END = '<!-- naso:auto:end -->';

/** Root dot-directories that are structure rather than tooling noise. */
const MEANINGFUL_DOT_DIRS = new Set(['.github']);

// ---------------------------------------------------------------------------
// File facts
// ---------------------------------------------------------------------------

/** Extension → human language label. Anything unlisted falls back to its ext. */
const LANGUAGE_BY_EXT = new Map(
  Object.entries({
    ts: 'TypeScript',
    tsx: 'TypeScript',
    mts: 'TypeScript',
    cts: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    mjs: 'JavaScript',
    cjs: 'JavaScript',
    py: 'Python',
    rb: 'Ruby',
    go: 'Go',
    rs: 'Rust',
    java: 'Java',
    kt: 'Kotlin',
    swift: 'Swift',
    m: 'Objective-C',
    mm: 'Objective-C++',
    php: 'PHP',
    cs: 'C#',
    c: 'C',
    h: 'C/C++ header',
    cc: 'C++',
    cpp: 'C++',
    hpp: 'C/C++ header',
    sh: 'Shell',
    bash: 'Shell',
    sql: 'SQL',
    graphql: 'GraphQL',
    gql: 'GraphQL',
    proto: 'Protobuf',
    json: 'JSON',
    jsonc: 'JSON',
    yml: 'YAML',
    yaml: 'YAML',
    toml: 'TOML',
    xml: 'XML',
    md: 'Markdown',
    mdx: 'Markdown',
    txt: 'text',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    gradle: 'Gradle',
  }),
);

/** Extensions that are worth counting as "code" when naming a dominant language. */
const CODE_EXTS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'm', 'mm', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp',
  'sql', 'graphql', 'gql', 'proto', 'sh', 'bash',
]);

/** Basenames that mark a file as the way into an area. */
const ENTRY_BASENAME = /^(index|main|app|server|mod|lib|__init__|__main__|entry|cli)\.[a-z]+$/i;

/** Files that declare what an area is, in rough order of authority. */
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle.kts',
  'build.gradle',
  'Package.swift',
  'Gemfile',
  'composer.json',
  'requirements.txt',
  'CMakeLists.txt',
  'Makefile',
  'justfile',
];

const toPosix = (p) => p.split(path.sep).join('/');

/** How deep the no-git fallback walk goes. Deeper than this and it is noise. */
const MAX_WALK_DEPTH = 4;

const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

/** Filesystem walk for repositories git does not know about. */
async function walkFiles(root, dir = root, depth = 0, out = []) {
  if (depth > MAX_WALK_DEPTH) return out;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    if (WALK_SKIP.has(dirent.name) || isNoisyDir(dirent.name)) continue;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walkFiles(root, full, depth + 1, out);
    } else if (dirent.isFile()) {
      out.push(toPosix(path.relative(root, full)));
    }
  }
  return out;
}

/**
 * Every file this repository knows about: tracked, staged, and untracked-but-
 * not-ignored. Deliberately the *worktree* view rather than `git ls-files`
 * alone, because a file the user has created but not committed is exactly the
 * one a briefing should already describe.
 *
 * `--exclude-standard` is what keeps node_modules, dist and coverage out, and
 * what keeps a locally-excluded AGENTS.md from being reported as a new area.
 *
 * `-z`, always. Git quotes a path with a non-ASCII character as `"\303\251.env"`
 * unless you ask it not to, and a scanner that then reports that string as a
 * filename has told the person reading it nothing they can act on. Splitting on
 * `\0` is the only form where every byte of the name survives.
 *
 * Deleted files are subtracted: `git ls-files` lists what the *index* knows, and
 * a briefing that describes a path somebody just deleted is stale on arrival.
 * Areas the user excluded in setup are subtracted here rather than at print time,
 * so generation, the checker and the pre-commit append cannot disagree.
 */
export async function listRepoFiles(cwd, { exclude = null } = {}) {
  const res = await run('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd });
  if (!res.ok) return walkFiles(cwd);

  // An explicit list wins over the saved one, and setup passes the union of both so the
  // preview and the generated file are filtered identically — a --exclude flag that only
  // took effect after the accept would be a lie the user caught one step too late.
  const prefixes = exclude ? normalizeExclusions(exclude) : configuredExclusions(await readConfig(cwd));
  const gone = await deletedPathsIn(cwd);

  return splitNul(res.stdout).filter((file) => !gone.has(file) && !isExcluded(file, prefixes));
}

/** Split NUL-delimited output into fields, dropping the empty tail. */
export function splitNul(stdout) {
  return String(stdout).split('\0').filter((field) => field.length > 0);
}

/** Paths the worktree no longer has, though the index still lists them. */
async function deletedPathsIn(cwd) {
  const res = await run('git', ['ls-files', '-d', '-z'], { cwd });
  return new Set(res.ok ? splitNul(res.stdout) : []);
}

/**
 * The repository's areas.
 *
 * A directory is an area. A file at the root is not, and the difference is not a
 * formatting preference: `package.json` and `README.md` and `LICENSE` describe the whole
 * project rather than one part of it, so listing them as areas produces a structure
 * section that names the repository as a peer of its own subdirectories, then leaves the
 * pre-commit hook obliged to append a "new area" line the first time somebody adds a
 * config file. Root files are still reported — as an inventory, in one line, where they
 * belong — but they are never areas, never UNCOVERED, and never auto-appended.
 *
 * `.git`, build output, dot-directories and root noise are dropped here rather than at
 * print time, so the same list feeds generation, the checker, the guide and the
 * auto-append in validate.mjs: one definition of "an area".
 */
export function topLevelEntries(files) {
  const byName = new Map();

  for (const file of files) {
    const segments = file.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    const [head, ...rest] = segments;
    if (head === '.git') continue;
    if (head.startsWith('.') && !MEANINGFUL_DOT_DIRS.has(head)) continue;

    const isDir = rest.length > 0;
    if (isDir && isNoisyDir(head)) continue;
    if (!isDir && isRootNoise(head)) continue;

    const existing = byName.get(head);
    if (existing) {
      existing.isDir = existing.isDir || isDir;
      existing.files.push(file);
    } else {
      byName.set(head, { name: head, isDir, files: [file] });
    }
  }

  return Array.from(byName.values()).sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
  );
}

/** The directories among `topLevelEntries`. This is the list of areas. */
export function areasOf(entries) {
  return (entries ?? []).filter((entry) => entry.isDir);
}

/** Which language dominates a file list, as { label, count, share }. */
export function dominantLanguage(files) {
  const counts = new Map();
  let total = 0;

  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!CODE_EXTS.has(ext)) continue;
    const label = LANGUAGE_BY_EXT.get(ext) ?? ext;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    total++;
  }

  if (total === 0) return null;

  const [label, count] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return { label, count, share: Math.round((count / total) * 100), total };
}

/** Language counts across every file, including data and docs. */
export function languageMix(files) {
  const counts = new Map();
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!ext) continue;
    const label = LANGUAGE_BY_EXT.get(ext) ?? ext;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Name -> responsibility, for names that mean the same thing in most repos.
 *
 * This is a hint, never the whole sentence, and it is only used when the name
 * matches. The evidence a line carries (file counts, manifests, entry points)
 * is what makes the line checkable; the role is what makes it readable.
 */
const ROLE_HINTS = [
  [/^\.github$/i, 'CI and repository settings'],
  [/^(src|source|lib|library|internal|pkg|packages|modules)$/i, 'application source'],
  [/^(app|apps|web|frontend|client|site|mobile)$/i, 'application code'],
  [/^(android|ios|macos|windows|linux)$/i, 'native platform project'],
  [/^(tests?|__tests__|spec|specs|e2e|cypress|playwright|fixtures?)$/i, 'tests'],
  [/^docs?$/i, 'documentation'],
  [/^(scripts?|tools?|tooling|bin|hack)$/i, 'developer scripts'],
  [/^(config|configs|ci)$/i, 'configuration'],
  [/^(infra|infrastructure|deploy|deployment|terraform|helm|k8s|docker)$/i, 'infrastructure'],
  [/^(migrations?|db|database|schema|prisma|seeds?)$/i, 'data layer'],
  [/^(assets?|public|static|images?|fonts?|icons?)$/i, 'static assets'],
  [/^(components?|views?|screens?|pages?|routes?|layouts?)$/i, 'user interface'],
  [/^(services?|api|server|backend|handlers?|controllers?)$/i, 'request handling'],
  [/^(store|state|redux|context)$/i, 'state'],
  [/^(models?|entities|schemas?|types?)$/i, 'domain types'],
  [/^patches?$/i, 'dependency patches'],
  [/^plugins?$/i, 'plugins'],
  [/^(credentials?|secrets?)$/i, 'credentials — never commit'],
];

/** What a manifest at an area's root implies about that area. */
const ROLE_BY_MANIFEST = new Map([
  ['package.json', 'self-contained package'],
  ['pyproject.toml', 'Python package'],
  ['Cargo.toml', 'Rust crate'],
  ['go.mod', 'Go module'],
  ['pom.xml', 'Java module'],
  ['build.gradle', 'Android/Gradle module'],
  ['build.gradle.kts', 'Gradle module'],
  ['Package.swift', 'Swift package'],
  ['Gemfile', 'Ruby bundle'],
  ['composer.json', 'PHP package'],
  ['requirements.txt', 'Python requirements'],
]);

/**
 * A one-word responsibility guess from an area's name, or null when the name is
 * not one of the conventional ones. Returning null is the point: the caller then
 * describes the area by what it measurably contains instead of guessing.
 */
export function roleFor(name) {
  const base = name.replace(/\/$/, '');
  const hint = ROLE_HINTS.find(([pattern]) => pattern.test(base));
  return hint ? hint[1] : null;
}

/** Read a tsconfig/eslintrc that may legally contain comments and trailing commas. */
export function parseJsonc(text) {
  const withoutComments = String(text)
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (match, comment) =>
      comment ? '' : match,
    )
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(withoutComments);
  } catch {
    return null;
  }
}

const readMaybeJson = async (file) => {
  const raw = await readFile(file, 'utf8').catch(() => null);
  return raw === null ? null : parseJsonc(raw);
};

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|\/__tests__\//;

/** Tooling facts pulled out of package.json / tsconfig / eslint config. */
async function detectConventions(cwd, files, pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (name) => Boolean(deps[name]);

  const tsconfig = await readMaybeJson(path.join(cwd, 'tsconfig.json'));
  const eslintConfig = await firstExistingFile(cwd, [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.json',
    '.eslintrc.cjs',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ]);
  const prettierConfig = await firstExistingFile(cwd, [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    'prettier.config.js',
    'prettier.config.mjs',
  ]);

  const testFiles = files.filter((f) => TEST_FILE.test(f));
  const testRoots = new Set(
    testFiles.map((f) => f.split('/')[0]).filter((segment) => segment.length > 0),
  );

  // Co-located means the test sits in a directory that also holds source. A test
  // directory of its own is a different convention, and the two lead an agent to
  // very different places when it goes looking for "where do I add a test".
  const testDirs = new Set(testFiles.map((f) => path.posix.dirname(f)));
  const sourceDirs = new Set(
    files.filter((f) => !TEST_FILE.test(f)).map((f) => path.posix.dirname(f)),
  );
  const sharedDirs = [...testDirs].filter(
    (dir) => dir !== '.' && sourceDirs.has(dir),
  ).length;
  const colocated = testDirs.size > 0 && sharedDirs >= testDirs.size / 2;

  const runner = has('vitest')
    ? 'vitest'
    : has('jest')
      ? 'jest'
      : has('mocha')
        ? 'mocha'
        : has('ava')
          ? 'ava'
          : has('@playwright/test')
            ? 'Playwright'
            : deps['node:test'] || files.some((f) => f.endsWith('.test.mjs'))
              ? 'node:test'
              : null;

  const moduleSystem = pkg?.type === 'module'
    ? 'ES modules (package.json declares "type": "module")'
    : files.some((f) => f.endsWith('.mjs')) && !files.some((f) => f.endsWith('.cjs'))
      ? 'ES modules (.mjs, no "type" field)'
      : pkg
        ? 'CommonJS by default (no "type": "module")'
        : null;

  return {
    deps,
    typescript: has('typescript')
      ? { version: deps.typescript, strict: tsconfig?.compilerOptions?.strict === true, hasTsconfig: Boolean(tsconfig) }
      : null,
    moduleSystem,
    runner,
    testFiles: testFiles.length,
    testRoots: Array.from(testRoots).sort(),
    colocated,
    eslintConfig,
    prettierConfig,
    tsconfigPaths: tsconfig?.compilerOptions?.paths ?? null,
    baseUrl: tsconfig?.compilerOptions?.baseUrl ?? null,
    eslintIgnores: eslintConfig?.ignorePatterns ?? null,
  };
}

async function firstExistingFile(cwd, candidates) {
  for (const name of candidates) {
    if (await pathExists(path.join(cwd, name))) return name;
  }
  return null;
}

/** Manifest sitting directly in an area, if any. */
async function manifestFor(cwd, entry) {
  const base = path.join(cwd, entry.name);
  for (const name of MANIFESTS) {
    if (await pathExists(path.join(base, name))) return name;
  }
  return null;
}

/**
 * The file that is the way into an area, chosen from files that actually exist.
 *
 * The extension has to be a real code extension: `app.json` matches the
 * filename shape but a JSON config is not an entry point, and listing it as one
 * sends an agent to a file with no code in it.
 */
function entryPointOf(entry) {
  const prefix = entry.isDir ? `${entry.name}/` : '';
  const candidates = entry.files
    .filter((file) => {
      const rest = prefix ? file.slice(prefix.length) : file;
      if (rest.includes('/')) return false;
      if (!ENTRY_BASENAME.test(rest)) return false;
      return CODE_EXTS.has(path.posix.extname(rest).slice(1).toLowerCase());
    })
    .sort();
  return candidates[0] ?? null;
}

/** Manifest fields that name a real entry point: main, module, bin, exports. */
function manifestEntryPoints(pkg) {
  if (!pkg) return [];
  const found = [];
  for (const key of ['main', 'module', 'browser']) {
    if (typeof pkg[key] === 'string') found.push({ field: key, value: pkg[key] });
  }
  if (typeof pkg.bin === 'string') found.push({ field: 'bin', value: pkg.bin });
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) {
      if (typeof value === 'string') found.push({ field: 'bin', value });
    }
  }
  return found;
}

/** Every validation command that can be read off this repository, best first. */
async function detectValidationCommands(cwd, pkg) {
  const commands = [];
  const scripts = pkg?.scripts ?? {};

  // `npm run <name>` is correct whichever package manager installed the repo,
  // and it is the one form that is always copy-pasteable.
  const ORDER = [
    ['lint', 'Lint'],
    ['typecheck', 'Type check'],
    ['test', 'Tests'],
    ['verify', 'Full verification'],
    ['format', 'Format'],
    ['build', 'Build'],
  ];
  for (const [name, label] of ORDER) {
    if (typeof scripts[name] === 'string') {
      commands.push({ label, command: `npm run ${name}`, script: name });
    }
  }

  const makefile = await readFile(path.join(cwd, 'Makefile'), 'utf8').catch(() => null);
  if (makefile) {
    for (const target of ['lint', 'test', 'check', 'build']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile) && !commands.some((c) => c.script === target)) {
        commands.push({ label: target, command: `make ${target}`, script: target });
      }
    }
  }

  if (await pathExists(path.join(cwd, 'Cargo.toml'))) {
    if (!commands.some((c) => c.script === 'test')) {
      commands.push({ label: 'Tests', command: 'cargo test', script: 'cargo-test' });
    }
  }
  if (await pathExists(path.join(cwd, 'pyproject.toml')) && !commands.some((c) => c.script === 'test')) {
    commands.push({ label: 'Tests', command: 'pytest', script: 'pytest' });
  }
  if (await pathExists(path.join(cwd, 'go.mod')) && !commands.some((c) => c.script === 'test')) {
    commands.push({ label: 'Tests', command: 'go test ./...', script: 'go-test' });
  }

  return commands;
}

/**
 * Feature -> folder, but only from a directory layout that actually declares
 * features. Returns [] when the repository has no such convention, which makes
 * the caller omit the section instead of inventing a table.
 */
function detectFeatureMap(files, pkg) {
  const LAYOUTS = [
    { dir: 'src/features', kind: 'feature' },
    { dir: 'features', kind: 'feature' },
    { dir: 'src/modules', kind: 'module' },
    { dir: 'modules', kind: 'module' },
    { dir: 'app', kind: 'route', needsRouter: true },
    { dir: 'src/app', kind: 'route', needsRouter: true },
  ];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  for (const layout of LAYOUTS) {
    if (layout.needsRouter && !deps.expo && !deps.next && !deps['expo-router']) continue;

    const prefix = `${layout.dir}/`;
    const depth = layout.dir.split('/').length;
    const groups = new Map();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const segments = file.split('/');
      if (segments.length <= depth) continue;
      const key = segments[depth];
      if (!groups.has(key)) groups.set(key, { key, isDir: segments.length > depth + 1, count: 0 });
      const group = groups.get(key);
      group.count++;
      group.isDir = group.isDir || segments.length > depth + 1;
    }

    const rows = Array.from(groups.values())
      .filter((group) => group.isDir)
      .sort((a, b) => a.key.localeCompare(b.key));

    if (rows.length >= 2) return { dir: layout.dir, kind: layout.kind, rows };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * Read everything the briefing is allowed to say.
 *
 * One pass over the file list plus the handful of manifests that can change the
 * meaning of that list. Nothing here opens a source file: the briefing describes
 * the shape of a repository, and reading code to summarise it would produce the
 * confident fiction this tool exists to replace.
 */
export async function scanRepo(cwd, { exclude = null } = {}) {
  const files = await listRepoFiles(cwd, { exclude });
  const pkg = await readJSONFile(path.join(cwd, 'package.json'));
  const entries = topLevelEntries(files);

  for (const entry of entries) {
    entry.manifest = await manifestFor(cwd, entry);
    entry.entryPoint = entryPointOf(entry);
    entry.language = dominantLanguage(entry.files);
    entry.testFiles = entry.files.filter((f) => TEST_FILE.test(f)).length;
    // Resolved once, here, so the generator, the pre-commit append and the guide
    // can never disagree about which areas are named and which are not.
    entry.role = roleFor(entry.name) ?? (entry.manifest ? ROLE_BY_MANIFEST.get(entry.manifest) ?? null : null);
  }

  const gitInfo = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });

  return {
    cwd,
    files,
    trackedCount: files.length,
    pkg,
    projectName: pkg?.name ?? path.basename(cwd),
    projectDescription: typeof pkg?.description === 'string' ? pkg.description : null,
    entries,
    areas: areasOf(entries),
    rootFileEntries: entries.filter((entry) => !entry.isDir),
    exclude: exclude ? normalizeExclusions(exclude) : configuredExclusions(await readConfig(cwd)),
    branch: gitInfo.ok ? gitInfo.stdout.trim() : null,
    conventions: await detectConventions(cwd, files, pkg),
    validation: await detectValidationCommands(cwd, pkg),
    featureMap: detectFeatureMap(files, pkg),
    manifestEntryPoints: manifestEntryPoints(pkg).filter((e) => e.value.startsWith('.')),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const humanize = (key) =>
  key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * "61 files, 2 of them Kotlin" — the size of an area, and the language that
 * actually appears in it.
 *
 * Deliberately counts *code* files separately from total files rather than
 * rounding to a percentage. `android/` in a React Native project is 2 Kotlin
 * files and 59 resources; "mostly Kotlin (3%)" would be arithmetic dressed up as
 * a description, and "all 2 files are Kotlin" would be a lie about 61.
 */
function fileCountSentence(entry) {
  const total = entry.files.length;
  const language = entry.language;

  if (!language || language.total === 0) return plural(total, 'file');
  if (language.total === total) {
    return total === 1 ? `1 file, ${language.label}` : `all ${plural(total, 'file')} are ${language.label}`;
  }
  return `${plural(total, 'file')}, ${language.total} of them ${language.label}`;
}

/**
 * One line per area: what it is, how big it is, and how to get in.
 *
 * The counts and the entry point are what make the line worth keeping — they go
 * stale visibly, whereas "this is where the app lives" does not. When neither the
 * name nor a manifest says what the area is for, the line says so rather than
 * guessing, because a wrong purpose is the one error an agent cannot detect on
 * its own and will confidently build on.
 */
export function describeEntry(entry) {
  const label = entry.isDir ? `${entry.name}/` : entry.name;
  const role = entry.role ?? roleFor(entry.name);

  const facts = [fileCountSentence(entry)];
  if (entry.testFiles > 0) facts.push(`${plural(entry.testFiles, 'test file')}`);
  if (entry.manifest) facts.push(`manifest \`${entry.isDir ? `${entry.name}/` : ''}${entry.manifest}\``);
  if (entry.entryPoint) facts.push(`entry \`${entry.entryPoint}\``);

  const responsibility = role ?? 'role not derivable from its name or a manifest';
  return `- \`${label}\` — ${responsibility}; ${facts.join('; ')}.`;
}

/** Root files as one wrapped list rather than a dozen one-line entries. */
export function renderRootFiles(entries) {
  const roots = entries.filter((entry) => !entry.isDir);
  if (roots.length === 0) return null;

  const names = roots.map((entry) => `\`${entry.name}\``).join(', ');
  const withEntries = roots
    .filter((entry) => entry.entryPoint)
    .map((entry) => `\`${entry.name}\``)
    .join(', ');

  return (
    `Root files, none of which is an area of its own: ${names}.` +
    (withEntries ? `\nOf those, ${withEntries} ${roots.filter((e) => e.entryPoint).length === 1 ? 'is' : 'are'} an entry point.` : '')
  );
}

/**
 * Name-based wording for a unit the scanner could not describe.
 *
 * Reached only when the unit is absent from the scan — a directory with no files
 * yet, or one git does not list. A name-based noun beats silence: a briefing
 * that quietly stops describing the repository is worse than a slightly wrong
 * noun somebody corrects in one edit.
 */
export function describeUnit(unit) {
  const isDir = unit.endsWith('/');
  const name = isDir ? unit.slice(0, -1) : unit;

  if (/^(readme|changelog|contributing|license|licence|notice)$/i.test(name)) {
    return 'project documentation';
  }
  if (/^(docs?|documentation)$/i.test(name)) return 'documentation';
  if (/^(test|tests|__tests__|spec|specs|e2e|cypress|fixtures?)$/i.test(name)) return 'tests';
  if (/^(src|lib|app|apps|pkg|packages|internal|cmd|source)$/i.test(name)) {
    return 'application source';
  }
  if (/^(scripts?|tools?|bin|tooling)$/i.test(name)) return 'developer scripts';
  if (/^(infra|infrastructure|deploy|deployment|terraform|helm|k8s|docker)$/i.test(name)) {
    return 'infrastructure';
  }
  if (/^(config|configs|ci)$/i.test(name)) return 'configuration';
  if (/^(migrations?|db|database|schema|seed|seeds)$/i.test(name)) return 'data layer';
  if (isDir) return 'a new top-level area';
  return 'a new top-level file';
}

/**
 * The briefing line for one unit, described from a scan when one is available.
 *
 * Shared by generation and by the pre-commit append, so an area added by a commit
 * is written to the same standard as the rest of the file — and, critically, with
 * no marker for a human to come back and fill. That was the exact failure mode
 * 2.x had: a briefing that can only be finished by hand never gets finished.
 */
export function lineForUnit(unit, facts) {
  const isDir = unit.endsWith('/');
  const name = isDir ? unit.slice(0, -1) : unit;
  const entry = facts?.entries?.find((candidate) => candidate.name === name);

  if (entry) return describeEntry(entry);
  return `- \`${unit}\` — ${describeUnit(unit)}; new in this commit.`;
}

/** Paths a new agent should open first, all verified to exist. */
function renderLookFirst(facts) {
  const lines = [];
  const seen = new Set();

  const push = (entryPath, why) => {
    if (!entryPath || seen.has(entryPath)) return;
    if (!facts.files.includes(entryPath)) return;
    seen.add(entryPath);
    lines.push(`- \`${entryPath}\` — ${why}`);
  };

  for (const { field, value } of facts.manifestEntryPoints) {
    push(value.replace(/^\.\//, ''), `package.json "${field}" — what the project publishes or runs`);
  }

  push('README.md', 'the project in its own words; check it before assuming anything below');
  push('package.json', 'scripts, dependencies and the runtime the project declares');

  for (const entry of facts.entries.filter((e) => !e.isDir && e.entryPoint)) {
    push(entry.name, 'entry point declared by its own filename');
  }

  const testRoot = facts.entries.find((entry) => entry.testFiles > 0);
  if (testRoot) {
    const testPath = testRoot.isDir ? `${testRoot.name}/` : testRoot.name;
    push(testPath, `${plural(testRoot.testFiles, 'test file')} — the executable description of expected behaviour`);
  }

  if (lines.length === 0) return null;
  return lines;
}

function renderConventions(facts) {
  const { conventions } = facts;
  const lines = [];

  const mix = languageMix(facts.files).slice(0, 4);
  if (mix.length > 0) {
    const total = mix.reduce((sum, item) => sum + item.count, 0);
    lines.push(
      `Language mix: ${mix.map((item) => `${item.label} ${item.count}`).join(', ')}` +
        ` (of ${total} files with a known extension).`,
    );
  }

  if (conventions.moduleSystem) lines.push(`Modules: ${conventions.moduleSystem}.`);

  if (conventions.typescript) {
    const parts = [`TypeScript ${conventions.typescript.version.replace(/^[\^~]/, '')}`];
    parts.push(conventions.typescript.hasTsconfig ? 'tsconfig.json present' : 'no tsconfig.json');
    if (conventions.typescript.hasTsconfig) {
      parts.push(conventions.typescript.strict ? '"strict": true' : '"strict" is not set');
    }
    lines.push(`${parts.join(', ')}.`);
  }

  if (conventions.runner || conventions.testFiles > 0) {
    const parts = [];
    if (conventions.runner) parts.push(`runner ${conventions.runner}`);
    parts.push(plural(conventions.testFiles, 'test file'));
    if (conventions.colocated) {
      parts.push('co-located with the source they test, not in a directory of their own');
    } else if (conventions.testRoots.length > 0) {
      parts.push(`under ${conventions.testRoots.map((r) => `\`${r}/\``).join(', ')}`);
    }
    lines.push(`Tests: ${parts.join(', ')}.`);
  }

  if (conventions.eslintConfig) lines.push(`Lint: ESLint configured by \`${conventions.eslintConfig}\`.`);
  if (conventions.prettierConfig) {
    lines.push(`Format: Prettier configured by \`${conventions.prettierConfig}\`.`);
  }

  const aliases = conventions.tsconfigPaths ? Object.entries(conventions.tsconfigPaths) : [];
  if (aliases.length > 0) {
    // Rendered without backticks on purpose: an alias target like "." or "src"
    // is a pattern, not a claim that the file "." exists, and the checker would
    // correctly report it as MISSING.
    const rendered = aliases.map(([alias, targets]) => `${alias} → ${targets.join(', ')}`);
    lines.push(`Import aliases (tsconfig "paths"): ${rendered.join('; ')}.`);
  }

  if (lines.length === 0) return null;
  return lines;
}

/** .gitignore entries worth telling an agent about, in file order. */
async function readIgnorePatterns(cwd) {
  const raw = await readFile(path.join(cwd, '.gitignore'), 'utf8').catch(() => null);
  if (raw === null) return [];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .slice(0, 8);
}

/**
 * The lines people cross by accident, stated as facts about this repository.
 *
 * Every item here is something the tooling already enforces; writing it down is
 * what lets an agent reason about the rule instead of rediscovering it by
 * tripping over it.
 */
async function renderBoundaries(facts) {
  const lines = [];
  const { conventions } = facts;

  if (conventions.tsconfigPaths) {
    const count = Object.keys(conventions.tsconfigPaths).length;
    lines.push(
      `${count} import alias${count === 1 ? '' : 'es'} are declared in tsconfig.json. ` +
        'An import that uses a bare relative path where an alias exists is the one ' +
        'mistake TypeScript will not catch for you.',
    );
  }

  if (Array.isArray(conventions.eslintIgnores) && conventions.eslintIgnores.length > 0) {
    // Not backticked: these are glob patterns, not paths that must exist.
    lines.push(
      `ESLint ignores ${conventions.eslintIgnores.join(', ')} — lint passes there because ` +
        'nothing is checked, not because the code is correct.',
    );
  }

  const ignored = await readIgnorePatterns(facts.cwd);
  if (ignored.length > 0) {
    lines.push(
      `git excludes ${ignored.join(', ')}. Nothing under those paths reaches a commit, and ` +
        'nothing under them is reviewed.',
    );
  }

  if (lines.length === 0) return null;
  return lines;
}

/**
 * Render the whole briefing.
 *
 * Sections that derive nothing are omitted rather than left as an invitation to
 * fill them in later — an empty heading reads as a section someone forgot, and
 * an agent that trusts the file will waste a turn looking for content that is
 * not coming.
 */
export async function renderBriefing(facts, { version, actor, now }) {
  const parts = [];

  parts.push(
    `${NASO_START}\n${TEMPLATE_HEADER.replace('__VERSION__', version)
      .replace('__ACTOR__', actor)
      .replace('__DATE__', now)}`,
  );

  parts.push(`# ${facts.projectName} — Agent Instructions`);
  parts.push(`> Generated by NASO ${version} on ${now} from the
> ${plural(facts.trackedCount, 'file')} this repository tracks. Every path below
> was read off disk while this file was written, and every count is a count.
> Where NASO could not derive a fact, the section is absent rather than guessed at.
>
> Maintained through normal code review. NASO never regenerates this file
> wholesale; the pre-commit hook appends at most one line per genuinely new area.`);

  const dirs = facts.areas;
  const rootFiles = renderRootFiles(facts.entries);
  const structure = [];
  if (dirs.length > 0) structure.push(dirs.map(describeEntry).join('\n'));
  if (rootFiles) structure.push(rootFiles);
  parts.push(`## Project Structure\n\n${structure.join('\n\n')}`);

  parts.push(
    `${AUTO_START}\n${AUTO_END}\n\n` +
      'New areas appear in the block above automatically as commits add them.',
  );

  const lookFirst = renderLookFirst(facts);
  if (lookFirst) {
    parts.push(`### Where To Look First\n\n${lookFirst.join('\n')}`);
  }

  if (facts.featureMap) {
    const rows = facts.featureMap.rows.slice(0, 20).map((row) => {
      const dir = `${facts.featureMap.dir}/${row.key}/`;
      const role = roleFor(row.key);
      return `| ${humanize(row.key)} | \`${dir}\` | ${plural(row.count, 'file')}${role ? `, ${role}` : ''} |`;
    });
    const omitted = facts.featureMap.rows.length - rows.length;
    const more = omitted > 0
      ? `\n\n${omitted} further director${omitted === 1 ? 'y' : 'ies'} exist under the same parent; this table is capped so the map stays scannable.`
      : '';
    parts.push(
      `## Feature To Folder Map\n\n` +
        `Read from the directory layout under \`${facts.featureMap.dir}/\`.\n\n` +
        `| Feature | Lives in | Notes |\n| --- | --- | --- |\n${rows.join('\n')}${more}`,
    );
  }

  const conventions = renderConventions(facts);
  if (conventions) {
    const validation = facts.validation.length
      ? `\n\n### Validation commands\n\nThese are the commands that must pass before work is called done.\n\n\`\`\`bash\n${facts.validation.map((c) => c.command).join('\n')}\n\`\`\``
      : '';
    parts.push(`## Code Conventions\n\n${conventions.join('\n')}${validation}`);
  }

  parts.push(`## Scope

Name the path prefixes that own a task **before** editing, so the pre-commit
hook can check the diff against what you claimed:

\`\`\`bash
export NASO_SCOPE=path/to/area,other/area
\`\`\`

Paths outside those prefixes are reported. Set \`NASO_SCOPE_STRICT=1\` to refuse
the commit instead of warning. Splitting unrelated work into its own commit is
usually the right answer, and this is how you find out when you have not.`);

  const boundaries = await renderBoundaries(facts);
  if (boundaries) parts.push(`## Boundaries\n\n${boundaries.join('\n')}`);

  parts.push(`## Secrets

Never print secret values from \`.env*\`, deployment secrets, service-role keys,
webhook secrets, tokens, or credentials. If one is already committed, stop and
report the path — never paste the value, not into a chat, not into a log.`);

  parts.push(`## Commit Standard

1. Inventory first. \`git status\`, then read the full diff before staging.
2. Stage explicit paths. Never stage a whole tree in a mixed working directory.
3. Split into logically scoped commits by concern; each should revert alone.
4. Conventional style: \`type(scope): summary\`, type from
   fix / feat / test / chore / docs / refactor, summary under ~70 characters.
5. The body explains *why*, not which lines moved. For a bug fix, name the root
   cause and the evidence.
6. No \`Co-Authored-By:\` trailer for the assisting agent or tool.
7. Never bypass the pre-commit hook, never amend a pushed commit, never
   force-push. Fix the finding and make a new commit.
8. When a commit adds a genuinely new area, the hook appends one line for it
   above. If this file is tracked and clean, that line is staged with the commit;
   otherwise it is left unstaged and reported.`);

  parts.push(`## Final Response Expectations

State, when the work is done:

- what changed, by file
- which validation command ran, and its result
- anything left uncommitted, and why
- remaining risks, gaps, or assumptions not verified`);

  parts.push(`${NASO_END}`);

  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

// NASO's own tools are named in a briefing as commands, not as repo paths, so
// flagging them as MISSING would be noise.
const TOOL_SCRIPT_NAMES =
  /^(briefing|guide|validate|doctor|init|setup|lib|lock|install|naso)\.mjs$/i;

/**
 * A path-shaped token: no globs, no angle brackets, no spaces.
 *
 * A briefing legitimately contains `git status`, `--no-verify` and
 * `type(scope): summary` in prose. Only path-shaped tokens are candidates for a
 * filesystem check; everything else is a false positive waiting to happen.
 */
const PATH_SHAPED_TOKEN = /^[\w.@~-]+(?:\/[\w.@~-]+)*\/?$/;

const MARKERS = ['TODO(fill)', 'TODO(describe)'];

/**
 * Remove fenced code blocks before hunting for path claims.
 *
 * Splitting on a single backtick misaligns the moment the document contains a
 * fence — an odd run of backticks means every span after it is read as the text
 * *between* two code spans, and prose gets tested as a filename. Stripping the
 * fences first removes the ambiguity, and it is also the correct scope: a path
 * inside a shell snippet is a command to run, not a claim about the repository.
 */
export function stripFencedBlocks(text) {
  return String(text).replace(/^```[\s\S]*?^```[ \t]*$/gm, '');
}

/**
 * Path tokens the briefing claims, from backticked spans only.
 *
 * Odd-index segments after splitting on ` are the inside of a code span; pairing
 * by regex instead would break on any stray backtick (see stripFencedBlocks).
 */
export function extractPathTokens(text) {
  const segments = stripFencedBlocks(text).split('`');
  const tokens = new Set();

  for (let i = 1; i < segments.length; i += 2) {
    const token = segments[i].trim();
    if (!token) continue;
    if (token.includes('*') || token.includes('<') || token.includes('>')) continue;
    if (token.includes(' ')) continue;
    if (token.startsWith('-')) continue;
    if (TOOL_SCRIPT_NAMES.test(token)) continue;
    if (!PATH_SHAPED_TOKEN.test(token)) continue;
    tokens.add(token);
  }
  return Array.from(tokens).sort();
}

/**
 * The repository's areas, by name, as git currently sees them.
 *
 * Directories only, `-z` only, exclusions and deletions applied — same rules as
 * `listRepoFiles`, because "the areas" has to mean one thing across the generator, the
 * checker, the guide and the pre-commit append.
 */
export async function listTopLevelEntries(cwd, { exclude = null } = {}) {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok) return null;

  const files = await listRepoFiles(cwd, { exclude });
  return areasOf(topLevelEntries(files)).map((entry) => `${entry.name}/`);
}

/** Which entries the briefing fails to cover. */
export function findUncovered(entries, briefingText) {
  return (entries ?? []).filter((entry) => !coversUnit(briefingText, entry));
}

/**
 * Compare the briefing against the repository.
 *
 * Three failure modes, and the middle one is the reason this exists: the old
 * shell snippet only ever checked paths the briefing claimed. It never checked
 * the areas that exist and were never mentioned, which is where the real gaps
 * are.
 */
export async function checkBriefing(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    return { ok: false, reason: 'missing', agentsPath, problems: [] };
  }

  const briefing = await readFile(agentsPath, 'utf8');
  const tokens = extractPathTokens(briefing);
  const entries = await listTopLevelEntries(cwd);

  const missing = [];
  for (const token of tokens) {
    if (!(await pathExists(path.join(cwd, token)))) missing.push(token);
  }

  const uncovered = findUncovered(entries, briefing);

  const markerCounts = MARKERS.map((marker) => ({
    marker,
    count: (briefing.match(new RegExp(escapeRegExp(marker), 'g')) ?? []).length,
  }));
  const unfilled = markerCounts.filter((m) => m.count > 0);

  const problems = [
    ...missing.map((m) => ({ kind: 'MISSING', item: m })),
    ...uncovered.map((u) => ({ kind: 'UNCOVERED', item: u })),
    ...unfilled.map((m) => ({ kind: 'UNFILLED', item: `${m.marker} x${m.count}` })),
  ];

  return {
    ok: problems.length === 0,
    agentsPath,
    briefing,
    tokens,
    entries: entries ?? [],
    missing,
    uncovered,
    unfilled,
    problems,
  };
}

/** Print a check result in the same shape for every caller. */
export function printCheck(result) {
  if (result.reason === 'missing') {
    console.error(`naso-dev briefing: no ${AGENTS_FILE} in ${path.dirname(result.agentsPath)}.`);
    console.error('  Run `npx naso-dev setup` against this repository first.');
    return;
  }

  if (result.missing.length > 0) {
    section(`MISSING (${result.missing.length}) — claimed by the briefing, not on disk`);
    for (const item of result.missing) console.log(`- ${item}`);
    console.log('');
  }

  if (result.uncovered.length > 0) {
    section(`UNCOVERED (${result.uncovered.length}) — on disk, absent from the briefing`);
    for (const item of result.uncovered) console.log(`- ${item}`);
    console.log('');
  }

  if (result.unfilled.length > 0) {
    section(`UNFILLED (${result.unfilled.length}) — placeholder markers still present`);
    for (const item of result.unfilled) console.log(`- ${item.marker}: ${item.count}`);
    console.log('');
  }

  if (result.ok) {
    console.log(
      `Briefing is consistent with the repository: ${result.tokens.length} path claim(s) ` +
        `verified, ${result.entries.length} top-level area(s) covered, no placeholders left.`,
    );
    return;
  }

  console.log(
    `${result.problems.length} problem(s). Every path the briefing claims must exist, every ` +
      'real area must be\nmentioned, and no placeholder marker may remain. ' +
      'Regenerate with `npx naso-dev briefing create --force`.',
  );
}

/**
 * Write AGENTS.md from a fresh scan, under the repo lock.
 *
 * Generation re-reads the repository inside the lock and re-renders from what it
 * finds there, so two concurrent setups produce one of two complete briefings
 * rather than a half-written file.
 */
/**
 * Write the NASO block into AGENTS.md, under the repo lock, without ever touching
 * anything a person wrote.
 *
 * Four cases, and the differences between them are the whole point:
 *
 *   no file            write the block as the whole file
 *   file, no markers   append the block below what is there, byte for byte
 *   file, markers     replace only what is between them — and only with --force
 *   --force            never reaches outside the markers, whatever else it does
 *
 * The 2.x behaviour — "AGENTS.md exists, so overwrite it" — is gone. A 193-line
 * hand-written AGENTS.md is not a stale cache entry, and a tool that deletes it on
 * setup is a tool nobody runs twice. `--force` now means exactly one thing: replace
 * the block between the markers. It is not, and cannot be, permission to rewrite the file.
 *
 * Generation re-reads the repository inside the lock and re-renders from what it
 * finds there, so two concurrent setups produce one of two complete briefings
 * rather than a half-written file.
 */
export async function createBriefing(cwd, { force = false, exclude = null } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);

  const version = await toolVersion();
  const actor = actorIdentity();
  const now = new Date().toISOString().slice(0, 10);

  const outcome = await withLock(
    cwd,
    async () => {
      const before = await readFile(agentsPath, 'utf8').catch(() => null);
      const existingLines = before === null ? 0 : before.split('\n').length;

      const facts = await scanRepo(cwd, { exclude });
      const block = await renderBriefing(facts, { version, actor, now });

      if (before === null) {
        await writeFile(agentsPath, block, 'utf8');
        return { ok: true, appended: false, agentsPath, content: block, facts };
      }

      const start = before.indexOf(NASO_START);
      const end = before.indexOf(NASO_END);

      if (start === -1 || end === -1 || end < start) {
        // No block of ours in the file: append one and keep every existing line.
        const separator =
          before.length === 0 || before.endsWith('\n\n')
            ? ''
            : before.endsWith('\n')
              ? '\n'
              : '\n\n';
        const appended = `${before}${separator}${block}`;
        await writeFile(agentsPath, appended, 'utf8');
        return { ok: true, appended: true, existingLines, agentsPath, content: appended, facts };
      }

      if (!force) {
        return { ok: false, reason: 'has-block', agentsPath, existingLines };
      }

      const replaced =
        before.slice(0, start) + block.trimEnd() + before.slice(end + NASO_END.length);
      await writeFile(agentsPath, replaced, 'utf8');
      return {
        ok: true,
        appended: false,
        replacedBlock: true,
        existingLines,
        agentsPath,
        content: replaced,
        facts,
      };
    },
    {
      reason: 'write the AGENTS.md briefing',
      onBusy: (holder) => {
        console.log(`  ! ${AGENTS_FILE} is locked by ${holder}; skipped the write.`);
      },
    },
  );

  return outcome.ok ? outcome.value : { ok: false, reason: 'locked', holder: outcome.holder };
}

/** Read one of the machine-readable header markers, or null when absent. */
export function readBriefingMarkerValue(content, field) {
  const pattern = new RegExp(`^<!--\\s*${field}:\\s*(.+?)\\s*-->$`, 'm');
  return content.match(pattern)?.[1] ?? null;
}

/**
 * Move the `<!-- version: X -->` stamp, and nothing else in the file.
 *
 * Used by `refresh`, whose whole promise is that a briefing somebody spent twenty minutes
 * on survives a version bump. Only the stamp line is rewritten; every other byte is
 * written back untouched.
 *
 * The stamp only ever moves forward. A briefing generated by a newer NASO than the tool
 * asking is reported and left alone: rewriting it would erase the only evidence that the
 * tool — not the briefing — needs updating.
 */
export async function refreshBriefingStamp(cwd, { current } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    return { ok: false, reason: 'missing', agentsPath };
  }

  const version = current ?? (await toolVersion());
  const content = await readFile(agentsPath, 'utf8');
  const stamped = readBriefingMarkerValue(content, 'version');

  if (!stamped) {
    return { ok: false, reason: 'unstamped', agentsPath };
  }
  if (stamped === version || compareVersions(stamped, version) > 0) {
    return { ok: true, changed: false, agentsPath, version, previous: stamped };
  }

  await writeFile(
    agentsPath,
    content.replace(/^<!--\s*version:\s*.+?\s*-->$/m, `<!-- version: ${version} -->`),
    'utf8',
  );
  return { ok: true, changed: true, agentsPath, version, previous: stamped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`NASO briefing

Usage:
  npx naso-dev briefing [dir]                    check the briefing against the repo
  npx naso-dev briefing [dir] check              same
  npx naso-dev briefing [dir] create             write the NASO block into AGENTS.md
  npx naso-dev briefing [dir] create --force     replace an existing naso:start/naso:end block
  npx naso-dev briefing [dir] refresh            move the version stamp only

Never rewrites anything outside <!-- naso:start --> and <!-- naso:end -->.

Exit codes: 0 clean, 1 problems found or the write was refused.
Support: ${SUPPORT_EMAIL}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }

  const [maybeCommand, ...rest] = positional;
  const COMMANDS = new Set(['check', 'create', 'refresh']);

  // The verb and the directory may come in either order. A positional that
  // matches a verb *and* names a directory that exists is a directory, so a repo
  // literally called `create` still works when named as `./create`.
  const isVerb = async (token) => COMMANDS.has(token) && !(await pathExists(path.resolve(token)));
  let command = 'check';
  let cwd;

  if (await isVerb(maybeCommand)) {
    command = maybeCommand;
    cwd = path.resolve(rest[0] ?? process.cwd());
  } else {
    cwd = path.resolve(maybeCommand ?? process.cwd());
  }
  for (const token of positional) {
    if (await isVerb(token)) command = token;
  }

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev briefing: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  if (command === 'create') {
    const result = await createBriefing(cwd, { force: flags.has('force') });
    if (!result.ok) {
      if (result.reason === 'has-block') {
        console.log(
          `- ${AGENTS_FILE} already has a naso:start / naso:end block. Left it exactly as it is.\n` +
            '  Re-run with --force to replace just that block. Nothing outside the markers\n' +
            '  is ever rewritten, with or without --force.',
        );
      } else {
        console.log(`- Skipped ${AGENTS_FILE}: locked by ${result.holder}.`);
      }
      process.exitCode = 1;
      return;
    }

    banner('Briefing', result.agentsPath);
    console.log(
      result.appended
        ? `Appended the NASO block below the ${plural(result.existingLines, 'line')} already in ${AGENTS_FILE}. Nothing existing was changed.`
        : result.replacedBlock
          ? `Replaced the naso:start / naso:end block. The other ${plural(result.existingLines, 'line')} of ${AGENTS_FILE} are byte for byte as you left them.`
          : `Wrote ${AGENTS_FILE} from ${plural(result.facts.trackedCount, 'file')}.`,
    );
    console.log('');
    for (const entry of result.facts.areas) {
      console.log(`  ${describeEntry(entry)}`);
    }
    const rootFiles = renderRootFiles(result.facts.entries);
    if (rootFiles) {
      console.log('');
      console.log(`  ${rootFiles.split('\n').join('\n  ')}`);
    }
    console.log('');
    const verified = await checkBriefing(cwd);
    printCheck(verified);
    if (!verified.ok) process.exitCode = 1;
    return;
  }

  if (command === 'refresh') {
    const result = await refreshBriefingStamp(cwd);
    if (!result.ok) {
      console.log(
        result.reason === 'missing'
          ? `- No ${AGENTS_FILE} in ${cwd} yet. Run \`naso setup\` to create it.`
          : `- No version stamp found in ${AGENTS_FILE}; nothing changed.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!result.changed) {
      if (compareVersions(result.previous, result.version) > 0) {
        console.log(
          `- ${AGENTS_FILE} was written by a newer NASO (${result.previous}); this tool is ${result.version}. ` +
            `Update naso-dev rather than downgrading the briefing.`,
        );
      } else {
        console.log(`- ${AGENTS_FILE} is already stamped ${result.version} — nothing to refresh.`);
      }
      return;
    }
    console.log(`- Refreshed ${AGENTS_FILE} version stamp: ${result.previous} -> ${result.version}`);
    console.log('  Briefing content untouched.');
    return;
  }

  banner('Briefing Check', cwd);
  const result = await checkBriefing(cwd);
  printCheck(result);
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev briefing: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
