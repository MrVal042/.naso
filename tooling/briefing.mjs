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
  detectPackageManager,
  pmRunText,
  isNoisyDir,
  escapeRegExp,
  compareVersions,
  isMainModule,
  toolVersion,
  banner,
  section,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { withLock, LOCK_FILENAME } from './lock.mjs';
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
 * The file index every count in the briefing is derived from, and where it came from.
 *
 * `git ls-files` with no `-o`. The index, and nothing else — that is a deliberate retreat
 * from the earlier worktree view, and the reason is a briefing that described build output:
 *
 *   ios/build/**, next-env.d.ts and friends are only excluded from a worktree listing
 *   because some ignore file happens to cover them. A repository with no `.gitignore`,
 *   or one whose native project directory is not listed, produced counts where a
 *   generated Objective-C file outweighed the TypeScript it was built from, and the
 *   briefing reported those numbers as fact.
 *
 * The index is the one view that cannot drift that way: a file is in it only once a person
 * decided it belongs in the repository. An untracked-but-not-ignored new source file is
 * genuinely not described until it is committed, which is a smaller and much more honest
 * failure than a briefing that counts `build/`.
 *
 * `-z`, always. Git quotes a path with a non-ASCII character as `"\303\251.env"` unless you
 * ask it not to, and a scanner that then reports that string as a filename has told the
 * person reading it nothing they can act on. Splitting on `\0` is the only form where every
 * byte of the name survives.
 *
 * Deleted files are subtracted: `git ls-files` lists what the *index* knows, and a briefing
 * that describes a path somebody just deleted is stale on arrival. Areas the user excluded
 * in setup are subtracted here rather than at print time, so generation, the checker and
 * the pre-commit append cannot disagree.
 *
 * `source` is the other half of the answer and it reaches the generated header: `'git'` means
 * every number in the file is a git-tracked count, `'fs'` means the directory is not a git
 * repository and these are filesystem counts instead, which is a weaker claim the reader has
 * to be told about rather than left to infer.
 */
export async function readFileIndex(cwd, { exclude = null } = {}) {
  const res = await run('git', ['ls-files', '-z'], { cwd });
  if (!res.ok) return { files: await walkFiles(cwd), source: 'fs' };

  // An explicit list wins over the saved one, and setup passes the union of both so the
  // preview and the generated file are filtered identically — a --exclude flag that only
  // took effect after the accept would be a lie the user caught one step too late.
  const prefixes = exclude ? normalizeExclusions(exclude) : configuredExclusions(await readConfig(cwd));
  const gone = await deletedPathsIn(cwd);

  const files = splitNul(res.stdout).filter(
    (file) => !gone.has(file) && !isExcluded(file, prefixes),
  );
  return { files, source: 'git' };
}

/** The index view as a plain list. Callers that report counts want `readFileIndex`. */
export async function listRepoFiles(cwd, { exclude = null } = {}) {
  return (await readFileIndex(cwd, { exclude })).files;
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
    if (head === '.git' || head === LOCK_FILENAME) continue;

    const isDir = rest.length > 0;
    // A dot-*directory* is almost always tool state (`.git`, `.expo`, `.idea`) and
    // `.github` is the exception the briefing does describe. A dot-*file* is the opposite:
    // `.gitignore`, `.nvmrc` and `.env.example` are tracked configuration that changes how
    // the repository builds, and dropping them made the root file list quietly incomplete
    // while still looking complete.
    if (head.startsWith('.') && isDir && !MEANINGFUL_DOT_DIRS.has(head)) continue;
    if (isDir && isNoisyDir(head)) continue;
    // Root files are listed in full, including the ones a briefing used to treat as
    // noise. `.nvmrc` and `.gitignore` change how the repository builds, and a list that
    // quietly omits them looks complete — which is how a Node version mismatch survives
    // review. Only directories are filtered for newsworthiness, so nothing is lost there.

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
  const tracked = new Set(files);
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
  // A file under a test directory (`test/`, `__tests__/`, `e2e/`…) is in a test tree,
  // whatever else sits beside it. Only a test file in a non-test directory that also holds
  // source is co-located. A repository with both is reported as both, with counts —
  // calling `test/a.test.mjs` co-located sent agents to add tests next to source.
  const TEST_DIR_SEGMENT = /^(?:test|tests|__tests__|spec|specs|e2e)$/i;
  const inTestTree = (file) => path.posix.dirname(file).split('/').some((seg) => TEST_DIR_SEGMENT.test(seg));
  const sourceDirs = new Set(
    files.filter((f) => !TEST_FILE.test(f)).map((f) => path.posix.dirname(f)),
  );
  const colocatedFiles = testFiles.filter(
    (f) => !inTestTree(f) && path.posix.dirname(f) !== '.' && sourceDirs.has(path.posix.dirname(f)),
  );
  const separateFiles = testFiles.filter((f) => !colocatedFiles.includes(f));
  const separateRoots = [...new Set(separateFiles.map((f) => f.split('/')[0]))].sort();
  const colocated = colocatedFiles.length > 0 && separateFiles.length === 0;

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

  // A repository is rarely one module system. `.mjs` beside `plugins/*.cjs` is two, and
  // the one-liner above would have to pick one — so each folder is classified on its own
  // and only the folders that differ from the repository default are named.
  const repoIsEsm = pkg?.type === 'module';
  const repoKind = repoIsEsm ? 'ES modules' : 'CommonJS';
  const mixedFolders = [];
  for (const entry of topLevelEntries(files)) {
    if (!entry.isDir) continue;
    const mjs = entry.files.filter((f) => f.endsWith('.mjs')).length;
    const cjs = entry.files.filter((f) => f.endsWith('.cjs')).length;
    const js = entry.files.filter((f) => f.endsWith('.js')).length;
    if (mjs === 0 && cjs === 0 && js === 0) continue;

    // A `.js` file is whatever the nearest package.json says. A folder with its own
    // manifest decides for itself — and one with no "type" is CommonJS even inside an
    // ESM repository, which is exactly the case that breaks an `import` written there.
    const ownManifest = `${entry.name}/package.json`;
    const own = tracked.has(ownManifest) ? await readMaybeJson(path.join(cwd, ownManifest)) : null;
    const jsKind = own ? (own.type === 'module' ? 'ES modules' : 'CommonJS') : repoKind;

    const kind = mjs > 0 ? 'ES modules' : cjs > 0 ? 'CommonJS' : jsKind;
    if (kind !== repoKind) {
      mixedFolders.push({
        folder: `${entry.name}/`,
        kind,
        evidence:
          mjs > 0
            ? plural(mjs, '.mjs file')
            : cjs > 0
              ? plural(cjs, '.cjs file')
              : `${plural(js, '.js file')}; ${ownManifest} ${own?.type ? `declares "type": "${own.type}"` : 'declares no "type"'}`,
      });
    }
  }

  return {
    deps,
    typescript: has('typescript')
      ? { version: deps.typescript, strict: tsconfig?.compilerOptions?.strict === true, hasTsconfig: Boolean(tsconfig) }
      : null,
    moduleSystem,
    mixedFolders,
    aliases: await detectAliases(cwd, tsconfig),
    runner,
    testFiles: testFiles.length,
    testRoots: Array.from(testRoots).sort(),
    colocated,
    colocatedCount: colocatedFiles.length,
    separateCount: separateFiles.length,
    separateRoots,
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

// ---------------------------------------------------------------------------
// Import aliases, in every file that declares them
// ---------------------------------------------------------------------------

/** One `alias: { ... }` block. Alias maps are flat in every config that has one. */
const ALIAS_BLOCK = /alias\s*:\s*\{([^{}]*)\}/g;
const ALIAS_ENTRY = /(['"`])([^'"`]+)\1\s*:\s*(['"`])([^'"`]*)\3/g;

/** Config files that can declare aliases, in the order an agent would have to keep in step. */
const ALIAS_CONFIG_FILES = [
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  '.babelrc',
  '.babelrc.js',
  '.babelrc.json',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.mts',
  'webpack.config.js',
  'webpack.config.cjs',
  'webpack.config.mjs',
  'webpack.config.ts',
];

/**
 * Aliases declared by one config file's text.
 *
 * A regex, not a parser, and the reason is the same one that keeps the vendored copy
 * dependency-free: this needs the keys of a flat object literal, and evaluating a config
 * to read it would mean running the repository's own code to describe the repository.
 * `root: [...]` is read too, because babel's module-resolver accepts it as a spelling of
 * the same thing and an agent that knows one file but not the other gets it wrong.
 */
export function parseAliasBlocks(text) {
  const aliases = new Map();
  const add = (alias, target) => {
    if (!alias || !target) return;
    const seen = aliases.get(alias) ?? [];
    if (!seen.includes(target)) aliases.set(alias, [...seen, target]);
  };

  for (const block of String(text).matchAll(ALIAS_BLOCK)) {
    for (const entry of block[1].matchAll(ALIAS_ENTRY)) add(entry[2], entry[4]);
  }

  // `root: [...]` is deliberately not folded into the alias list. In babel's
  // module-resolver it changes what a *relative* import resolves against — a different
  // mechanism with a different failure mode — and calling it an alias would put a path in
  // this list that no import actually uses.

  return aliases;
}

/**
 * One alias, however a config spells it.
 *
 * tsconfig writes `@a/*` → `src/a/*` and babel writes `@a` → `./src/a`, and both mean
 * "imports starting @a/ resolve under src/a". Comparing the raw keys reported the same
 * alias as missing from both files — a divergence that does not exist, in the section an
 * agent reads to decide where to add the next one.
 */
export const canonicalAlias = (alias) => String(alias).replace(/\/\*$/, '').replace(/\/+$/, '') || String(alias);
const canonicalTarget = (target) =>
  String(target).replace(/^\.\//, '').replace(/\/\*$/, '').replace(/\/+$/, '') || '.';

function canonicalAliases(raw) {
  const out = new Map();
  for (const [alias, targets] of raw) {
    const key = canonicalAlias(alias);
    const entry = out.get(key) ?? { spelling: alias, targets: [] };
    for (const target of targets) {
      const normal = canonicalTarget(target);
      if (!entry.targets.includes(normal)) entry.targets.push(normal);
    }
    out.set(key, entry);
  }
  return out;
}

/**
 * Every alias declaration in the repository, and where each one is declared.
 *
 * The gap this closes is the one that costs an afternoon: tsconfig declares `@/`, babel
 * does not, Metro builds and `tsc` disagrees about the same import, and neither tool says
 * why. So the sources are collected first and compared afterwards — a single alias list
 * could not tell "declared once" from "declared everywhere it needs to be".
 */
export async function detectAliases(cwd, tsconfig) {
  const sources = [];
  const fromTsconfig = new Map(
    Object.entries(tsconfig?.compilerOptions?.paths ?? {}).map(([alias, targets]) => [
      alias,
      Array.isArray(targets) ? targets.map(String) : [String(targets)],
    ]),
  );
  if (fromTsconfig.size > 0) sources.push({ file: 'tsconfig.json', aliases: canonicalAliases(fromTsconfig) });

  for (const file of ALIAS_CONFIG_FILES) {
    const text = await readFile(path.join(cwd, file), 'utf8').catch(() => null);
    if (text === null) continue;
    const aliases = parseAliasBlocks(text);
    if (aliases.size > 0) sources.push({ file, aliases: canonicalAliases(aliases) });
  }

  const files = sources.map((source) => source.file);
  const names = [...new Set(sources.flatMap((source) => [...source.aliases.keys()]))].sort();
  const declared = names.map((alias) => ({
    alias,
    targets: [...new Set(sources.flatMap((source) => source.aliases.get(alias)?.targets ?? []))],
    files: sources.filter((source) => source.aliases.has(alias)).map((source) => source.file),
    // How each file spells it, so `@a/*` in tsconfig is still shown as written.
    spellings: Object.fromEntries(
      sources.filter((source) => source.aliases.has(alias)).map((source) => [source.file, source.aliases.get(alias).spelling]),
    ),
    absent: sources.filter((source) => !source.aliases.has(alias)).map((source) => source.file),
  }));

  return { files, declared, divergent: declared.filter((entry) => entry.absent.length > 0) };
}

// ---------------------------------------------------------------------------
// What the test script actually runs
// ---------------------------------------------------------------------------

/** Words in a test script that are the runner or how to drive it, never a path. */
const RUNNER_WORD =
  /^(?:node|npx|jest|vitest|mocha|ava|tsx|ts-node|playwright|pnpm|npm|yarn|bun|bunx|run|watch|t|ci|all|changed|related|coverage|silent|bail|passWithNoTests|ui|list|install|config|help|version|register|experimental-vm-modules)$/;

/** A file a test script executes rather than names as input. */
const SCRIPT_FILE = /\.(?:sh|bash|zsh|ps1|[cm]?js|ts|py)$/;

/** A path-ish token: contains a separator, a glob, or a test file extension. */
const PATH_LIKE = /[/\\*]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The paths and globs a test script names, as a shell would see them.
 *
 * The distinction that matters is between a script that names its inputs and one that
 * does not. `node --test test/` runs exactly what is under `test/`; `node --test` with no
 * argument walks the whole tree. Those two look the same in a package manifest and mean
 * opposite things about whether a test file is covered, so a script that names nothing is
 * reported as `openEnded` and never produces a coverage claim in either direction.
 */
export function parseTestTargets(scriptBody) {
  if (typeof scriptBody !== 'string' || scriptBody.trim() === '') {
    return { targets: [], openEnded: true };
  }

  const tokens = scriptBody
    .replace(/['"`]/g, ' ')
    .split(/[\s|&;()]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const runnerNamed = tokens.some((token) => /^(?:node|npx|jest|vitest|mocha|ava|tsx|ts-node|pnpm|npm|yarn|bun|bunx)$/.test(token));
  const targets = tokens.filter((token) => {
    if (token.startsWith('-')) return false;
    if (RUNNER_WORD.test(token)) return false;
    // A bare word is only a target when a runner is there to give it meaning: `vitest run
    // src` targets src/, but `echo "no tests here"` targets nothing.
    return PATH_LIKE.test(token) || runnerNamed;
  });

  // A script file in the body is a program the script runs, not a set of tests. What it
  // goes on to run is inside it, out of sight, so its own path is no coverage claim: a
  // monorepo whose `test:workspace` was `./tooling/scripts/test-workspace.sh` was told
  // 155 test files were run by nothing.
  if (targets.some((token) => SCRIPT_FILE.test(token) && !TEST_FILE.test(token) && !token.includes('*'))) {
    return { targets: [], openEnded: true };
  }

  return { targets, openEnded: targets.length === 0 };
}

/** Does one test-script target cover one tracked file? */
function targetCovers(target, file) {
  const pattern = target.replace(/[/\\]+$/, '');
  if (!pattern) return false;

  if (pattern.includes('*') || pattern.includes('?') || pattern.includes('{')) {
    // `?` is translated before the globstar group is inserted, or the `?` this function
    // writes would be translated again and turn `**/` into a single-segment match.
    const GLOBSTAR = '~~globstar~~';
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\?/g, '[^/]')
      .replace(/\*\*\//g, GLOBSTAR)
      .replace(/\*/g, '[^/]*')
      .replaceAll(GLOBSTAR, '(?:.*/)?');
    return new RegExp(`^${source}$`).test(file) || new RegExp(`(?:^|/)${source}$`).test(file);
  }

  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(pattern)) return file === pattern;
  return file === pattern || file.startsWith(`${pattern}/`);
}

/** The runner a script body names, ahead of anything guessed from dependencies. */
function runnerFromScript(scriptBody) {
  const body = String(scriptBody ?? '');
  if (/(?:^|\s)node\s+(?:-{1,2}[\w-]+\s+)*--test\b/.test(body)) return 'node:test';
  for (const [bin, label] of [
    ['vitest', 'vitest'],
    ['jest', 'jest'],
    ['mocha', 'mocha'],
    ['ava', 'ava'],
    ['playwright', 'Playwright'],
    ['detox', 'detox'],
  ]) {
    if (new RegExp(`\\b${bin}\\b`).test(body)) return label;
  }
  return null;
}

/**
 * Which tracked test files the test script never runs.
 *
 * This is the finding a repository cannot notice on its own: the file is tracked, so it
 * reads as covered by anyone who lists the tree, and the script that would run it does not
 * name it. In a project with both `test/` and `e2e/`, `pnpm test` passing says nothing at
 * all about `e2e/` — and the briefing used to say "tests: 2 test files" as though it did.
 *
 * Only tracked files are compared, because an untracked test file is not a claim anybody
 * made, and a script that names no paths produces no claim in either direction.
 */
export function findUncoveredTests(testFiles, targets) {
  return testFiles.filter((file) => !targets.some((target) => targetCovers(target, file)));
}

/**
 * Everything the briefing can say about tests: the runner, what the script runs, and the
 * tracked test files it leaves behind.
 */
export function detectTestCoverage(files, pkg, pm = 'npm', declaredRunner = null) {
  const scripts = pkg?.scripts ?? {};
  const names = Object.keys(scripts);
  const name = names.includes('test') ? 'test' : (names.find((n) => /^test[:.]/.test(n)) ?? null);
  const body = name ? scripts[name] : null;
  const { targets, openEnded } = parseTestTargets(body);
  const testFiles = files.filter((file) => TEST_FILE.test(file));

  return {
    script: name,
    command: name ? pmRunText(pm, name) : null,
    runner: runnerFromScript(body) ?? declaredRunner,
    targets,
    openEnded,
    total: testFiles.length,
    missed: openEnded ? [] : findUncoveredTests(testFiles, targets),
  };
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
  // `./server.js` and `server.js` name the same file, and the manifest is the only place
  // the repository states which one it means, so the leading `./` is normalised once here
  // rather than re-stripped by every reader.
  const normalize = (value) => value.replace(/^\.\//, '');
  // `module: "ES2020"` and `browser: {...}` are fields named like paths that are not
  // files, so each value is checked before it is normalised into one.
  const asPath = (value) => /^\.{0,2}\//.test(value) || /\.[cm]?[jt]sx?$/.test(value);
  for (const key of ['main', 'module', 'browser']) {
    if (typeof pkg[key] === 'string' && asPath(pkg[key])) {
      found.push({ field: key, value: normalize(pkg[key]) });
    }
  }
  if (typeof pkg.bin === 'string' && asPath(pkg.bin)) {
    found.push({ field: 'bin', value: normalize(pkg.bin) });
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) {
      if (typeof value === 'string' && asPath(value)) {
        found.push({ field: 'bin', value: normalize(value) });
      }
    }
  }
  return found;
}

/**
 * Script names that mean "this is the gate" when there is no verify/check/ci.
 * Nothing here is invented: a gate is a command this repository actually runs.
 */
const GATE_SCRIPT_NAMES = ['verify', 'check', 'ci'];

/**
 * Scripts whose name says they enforce something, surfaced by name whatever else happens.
 *
 * These are the checks a repository points at to say "this is what we care about", and
 * listing only the ones that happen to be wired into the gate hides the ones somebody
 * wrote and never connected. The briefing names them so an agent can see both.
 */
const ENFORCEMENT_SCRIPT = /(secret|scan|boundar|hardening|dependenc)/i;

/** Subcommands that make a manager invocation housekeeping rather than a check. */
const PM_CHAIN_NOISE = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'unlink', 'ci', 'audit', 'fund', 'publish', 'pack',
  'cache', 'config', 'version', 'help', 'h', 'init', 'why', 'list', 'ls', 'll', 'outdated',
  'update', 'upgrade', 'link', 'prune', 'store', 'info', 'patch', 'create', 'import', 'login',
  'logout', 'whoami', 'team', 'root', 'bin', 'rebuild', 'dedupe', 'doctor',
]);

/** Words that only say how to run something, not what to run. */
const RUN_CARRIERS = new Set(['run', 'run-script', 'exec', 'x', 'dlx', 'dlx-bin']);

/** Binaries worth naming when they are invoked directly rather than through a script. */
const DIRECT_BINARY = /^(?:node|npx|expo|tsc|eslint|prettier|jest|vitest|ava|mocha|detox|ts-node|tsx|swc|gradlew)\b/;

/** `run('pnpm', ['run', 'lint'])` — the shape a JavaScript gate script actually uses. */
const JS_RUN_CALL =
  /\b(?:run|exec|execFile|spawn|spawnSync|execa|execaSync)\s*\(\s*(['"`])([\w.:-]+)\1\s*,\s*\[([^\]]*)\]/g;

/** `const checks = ['lint', 'test']` — a literal array a gate iterates over. */
const JS_LITERAL_ARRAY = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g;

/** `for (const step of steps)` — the loop variable of a literal array, under its own name. */
const JS_FOR_OF = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;

/**
 * Literal string arrays declared in a script, keyed by every name they answer to.
 *
 * This exists so the most common shape of gate is read rather than skipped:
 *
 *   const steps = ['lint', 'test'];
 *   for (const step of steps) await run('pnpm', ['run', step]);
 *
 * The strings are in the file; following the variable is reading, not guessing. A loop over
 * anything else — an import, a glob, a computed name — resolves to nothing and is skipped,
 * because there is no honest way to render it as a command to paste.
 */
function literalArrays(text) {
  const source = String(text);
  const arrays = new Map();

  for (const match of source.matchAll(JS_LITERAL_ARRAY)) {
    arrays.set(match[1], [...match[2].matchAll(/(['"`])([^'"`]*)\1/g)].map((word) => word[2]));
  }

  for (const match of source.matchAll(JS_FOR_OF)) {
    const words = arrays.get(match[2]);
    if (words) arrays.set(match[1], words);
  }

  return arrays;
}

/**
 * The commands a piece of shell or JavaScript actually invokes, in document order.
 *
 * Static and deliberately shallow — this reads text, it does not run anything. It exists
 * because the alternative was worse: the previous generator listed every script whose name
 * looked important as though they were peers, so an agent was told to run `lint`, `test`
 * and `verify` when `verify` already ran the first two. Ordering is preserved, because the
 * order is the whole point of a gate and a shuffled list reads as another checklist.
 *
 * Three shapes, all of which are what real gates are written in:
 *
 *   shell   `pnpm run lint && pnpm exec expo check`
 *   js      `run('pnpm', ['run', 'lint'])`
 *   bare    `expo check` on a line of its own
 *
 * Housekeeping verbs are dropped. `pnpm install` really is in the workflow; it is not part
 * of what must pass before work is done, and listing it as a check to run by hand is exactly
 * the second dependency tree this file exists to prevent.
 */
export function extractInvocations(text) {
  const source = String(text);
  const arrays = literalArrays(source);
  const hits = [];

for (const match of source.matchAll(JS_RUN_CALL)) {
    const [, , bin, array] = match;
    const tokens = [];

    // Walk the argument list in written order so `['exec', 'expo', 'check']` stays three
    // words and `['run', checks]` becomes one command per element of `checks`.
    let unresolved = false;
    for (const token of array.matchAll(/(['"`])([^'"`]*)\1|([A-Za-z_$][\w$]*)/g)) {
      if (token[3] !== undefined) {
        const resolved = arrays.get(token[3]);
        if (!resolved) unresolved = true;
        else tokens.push({ spread: resolved });
        continue;
      }
      tokens.push({ word: token[2] });
    }

    // `run('pnpm', ['run', steps[i]])` cannot be rendered as a command anyone could paste.
    if (unresolved) continue;

    const spread = tokens.findIndex((token) => token.spread);
    const variants =
      spread === -1
        ? [tokens.map((token) => token.word ?? '').join(' ')]
        : tokens[spread].spread.map((word) =>
            tokens.map((token, at) => (at === spread ? word : (token.word ?? ''))).join(' '),
          );

    for (const variant of variants) {
      if (variant.split(/\s+/).filter((word) => !RUN_CARRIERS.has(word)).length === 0) continue;
      hits.push({ at: match.index, command: `${bin} ${variant}` });
    }
  }

  let cursor = 0;
  for (const segment of source.split(/&&|\|\||;|\n/)) {
    const at = source.indexOf(segment, cursor);
    cursor = at + segment.length;

    const line = segment.replace(/^\s*(?:\$\s*)?/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const manager = line.match(/^(npm|pnpm|yarn|bun)\s+(\S)/);
    if (manager) {
      const args = line.slice(manager[1].length).trim();
      const first = args.split(/\s+/)[0];
      const head = args.replace(/^(?:run|run-script)\s+/, '').split(/\s+/)[0];
      if (PM_CHAIN_NOISE.has(first) || PM_CHAIN_NOISE.has(head)) continue;
      hits.push({ at, command: `${manager[1]} ${args}` });
      continue;
    }

    if (DIRECT_BINARY.test(line)) hits.push({ at, command: line });
  }

  const seen = new Set();
  return hits
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.command.replace(/\s+/g, ' ').trim())
    .filter((command) => (seen.has(command) ? false : seen.add(command)));
}

/**
 * A short, human label for one invocation.
 *
 * A script name wins over the command that ran it, because `pnpm run check:secrets` is
 * better described as "secret check" than repeated verbatim. Anything not backed by a
 * script is described by what it is — `expo check` is a real gate command with no script
 * behind it, and calling it "check" would lose the only part that identifies it.
 */
export function labelForInvocation(command, scripts = {}) {
  const cleaned = String(command).replace(/^(?:npm|pnpm|yarn|bun)\s+(?:exec|x|dlx)\s+/, '');
  const script = cleaned.match(/^(?:npm|pnpm|yarn|bun)\s+run?\s+([A-Za-z][\w:.-]*)/)?.[1];
  // The name is used whether or not package.json declares it. A workflow or gate script
  // that names something the manifest has lost is still the truth about what runs, and
  // echoing the whole command back would make the label useless for coverage matching.
  if (script) return script;
  if (/^(?:npx\s+)?tsc\b/.test(cleaned)) return 'typecheck';
  if (/^expo\s+check/.test(cleaned)) return 'expo check';
  if (/^expo\s+lint/.test(cleaned)) return 'lint';
  if (/^eslint\b/.test(cleaned)) return 'lint';
  if (/^prettier\b/.test(cleaned)) return 'format';
  if (/^(?:npx\s+)?(?:jest|vitest|ava|mocha)\b/.test(cleaned)) return 'test';
  return cleaned;
}

/**
 * The shared middle of a family of script names: `verify:boundary:auth` → `boundary`.
 *
 * Four boundary verifiers written as four lines is noise the reader has to fold in their
 * head, and "four things called boundary-something" is the actual fact. Generic leading
 * verbs and the specific trailing qualifier are dropped because neither identifies the
 * family; what remains does.
 */
export function stepFamily(label) {
  const parts = String(label).split(/[:/]/).filter(Boolean);
  if (parts.length <= 1) return label;

  const generic = /^(verify|check|run|do|lint|test|ci)$/i;
  const core = parts.filter((part) => !generic.test(part));
  if (core.length === 0) return parts[0];
  return core.length === 1 ? core[0] : core.slice(0, -1).join(' ');
}

/**
 * Ordered, de-duplicated step labels, collapsing repeats of one family into `family ×n`.
 *
 * A family of one keeps its own name. `check:secrets` shortened to `secrets` would read as
 * a different command than the one in package.json, and the whole point of the section is
 * that the labels can be pasted back into a terminal. Only a genuine repeat earns the
 * `×n`, because that is the case where four lines would be noise.
 */
export function collapseSteps(labels) {
  const groups = new Map();

  for (const label of labels) {
    const family = stepFamily(label);
    const existing = groups.get(family);
    if (existing) existing.count++;
    else groups.set(family, { family, label, count: 1 });
  }

  return Array.from(groups.values()).map(
    (group) => (group.count > 1 ? `${group.family} ×${group.count}` : group.label),
  );
}

/**
 * The jobs in a GitHub Actions workflow, with the commands each one runs.
 *
 * Hand-rolled rather than pulling a YAML parser, and the reason is the same one that keeps
 * the vendored copy dependency-free: this only needs `jobs:`, `name:` and `run:`, and a
 * parser would be a larger dependency than the thing it parses. It reads `run: inline`,
 * `run: |` and `run: >` block scalars by indentation, which covers how workflows are
 * actually written. A workflow it cannot understand yields fewer jobs, never wrong ones —
 * every invocation it reports is one it saw verbatim in the file.
 */
export function parseWorkflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  let job = null;
  let blockIndent = -1;

  const note = (value) => {
    if (job) job.commands.push(...extractInvocations(value));
  };

  for (const raw of String(text).split('\n')) {
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    if (/^\S/.test(raw) && raw.trim() !== '') {
      inJobs = false;
      blockIndent = -1;
      continue;
    }

    const jobHeader = raw.match(/^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (jobHeader) {
      job = { name: jobHeader[1], label: jobHeader[1], commands: [] };
      jobs.push(job);
      blockIndent = -1;
      continue;
    }
    if (!job) continue;

    const indent = raw.length - raw.trimStart().length;
    if (blockIndent >= 0 && indent > blockIndent) {
      note(raw);
      continue;
    }
    blockIndent = -1;

    const jobName = raw.match(/^ {4}name:\s*(.+?)\s*$/);
    if (jobName) {
      job.label = jobName[1].replace(/^["']|["']$/g, '');
      continue;
    }

    if (/^\s*-\s*run:\s*[|>]\s*$/.test(raw)) {
      blockIndent = indent;
      continue;
    }

    const inline = raw.match(/^\s*-\s*run:\s*(\S.*?)\s*$/);
    if (inline) {
      note(inline[1]);
      continue;
    }
  }

  return jobs.filter((entry) => entry.commands.length > 0);
}

/** The job most likely to be the gate: named like one, and the richest when none is. */
export function pickGateJob(jobs) {
  if (jobs.length === 0) return null;

  const named = jobs.filter((entry) => /verify|check|ci|gate|quality/i.test(`${entry.name} ${entry.label}`));
  const pool = named.length > 0 ? named : jobs;
  return pool.reduce((best, entry) => (entry.commands.length > best.commands.length ? entry : best));
}

/** Every workflow file, as [{ file, text }]. Sorted, so the choice is deterministic. */
async function readWorkflows(cwd) {
  const dir = path.join(cwd, '.github', 'workflows');
  const names = (await readdir(dir).catch(() => [])).filter((name) => /\.ya?ml$/.test(name)).sort();
  const out = [];
  for (const name of names) {
    const text = await readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (text) out.push({ file: `.github/workflows/${name}`, text });
  }
  return out;
}

/** The one script a workflow job delegates to, or null when it runs several things itself. */
function soleScriptOf(job, scripts) {
  if (job.commands.length !== 1) return null;
  const name = job.commands[0].match(/^(?:pnpm|yarn|bun|npm)\s+run?\s+([A-Za-z][\w:.-]*)/)?.[1];
  return name && scripts[name] ? name : null;
}

/** `node scripts/verify.mjs`, `bash scripts/ci.sh` — the file a script body delegates to. */
const SCRIPT_DELEGATES_TO = /(?:^|\s)(?:node|tsx|babel-node|bash|sh|zsh|python3?)\s+([\w./@-]+\.(?:mjs|cjs|js|ts|sh))\b/;

/**
 * What a gate script actually runs, read from the file it delegates to.
 *
 * Two shapes are understood, because those are the two that exist in practice:
 *
 *   `a && b && c`        split on the chain, each side extracted as an invocation
 *   `node scripts/x.mjs` read that file and extract the invocations inside it
 *
 * Everything else returns `parsed: false` with the file to read. That is the whole
 * contract: a gate NASO cannot decompose is reported as "could not be parsed, see <file>",
 * and never as a list of plausible-looking checks. A wrong list here is worse than no
 * list, because it is a list an agent will follow.
 */
export async function expandGateScript(cwd, body, scripts = {}) {
  const trimmed = String(body).trim();

  if (/&&|\|\||;|\n/.test(trimmed) && !SCRIPT_DELEGATES_TO.test(trimmed)) {
    const commands = extractInvocations(trimmed);
    if (commands.length > 0) {
      return {
        steps: commands.map((command) => labelForInvocation(command, scripts)),
        commands,
        parsed: true,
        file: null,
      };
    }
  }

  const delegate = trimmed.match(SCRIPT_DELEGATES_TO)?.[1];
  if (delegate) {
    const file = delegate.replace(/^\.\//, '');
    const text = await readFile(path.join(cwd, file), 'utf8').catch(() => null);
    // A script body that names a file which is not there is a broken gate, not an
    // unreadable one — and naming it in the briefing would make the checker report the
    // path as MISSING, which is a confusing way to say "this repository has a typo".
    if (text === null) return { steps: [], commands: [], parsed: false, file: null };

    const commands = extractInvocations(text);
    if (commands.length === 0) return { steps: [], commands, parsed: false, file };
    return {
      steps: commands.map((command) => labelForInvocation(command, scripts)),
      commands,
      parsed: true,
      file,
    };
  }

  const commands = extractInvocations(trimmed);
  if (commands.length > 0) {
    return {
      steps: commands.map((command) => labelForInvocation(command, scripts)),
      commands,
      parsed: true,
      file: null,
    };
  }

  return { steps: [], commands: [], parsed: false, file: null };
}

/**
 * The repository's gate: the one command that must pass, and what it subsumes.
 *
 * Authority is ordered by how much the repository itself committed to it:
 *
 *   1. .github/workflows — CI is the answer nobody can forget to update, and a workflow
 *      that names a job `verify` is stating its own contract.
 *   2. a `verify` / `check` / `ci` script in package.json — the local equivalent.
 *
 * When the workflow's gate job delegates to a single script, that script *is* the gate and
 * the workflow is cited as the authority for it. When the job runs several commands itself
 * there is no local gate to recommend, and the briefing says so instead of inventing one.
 *
 * `unparsed` is the escape hatch, and the rule behind it: a gate NASO could not decompose
 * is reported as unread, never guessed at.
 */
export async function detectGate(cwd, pkg, pm = 'npm') {
  const scripts = pkg?.scripts ?? {};
  const empty = {
    command: null,
    script: null,
    authority: null,
    steps: [],
    rawSteps: [],
    commands: [],
    parsed: true,
    unparsed: null,
    stepFile: null,
    managersUsed: [],
    managerMismatch: false,
    enforcement: [],
    others: [],
  };

  for (const workflow of await readWorkflows(cwd)) {
    const job = pickGateJob(parseWorkflowJobs(workflow.text));
    if (!job) continue;

    const sole = soleScriptOf(job, scripts);
    const expansion = sole
      ? await expandGateScript(cwd, scripts[sole], scripts)
      : {
          steps: job.commands.map((command) => labelForInvocation(command, scripts)),
          commands: job.commands,
          parsed: true,
          file: null,
        };

    const used = [...new Set(expansion.commands.map((c) => c.split(/\s+/)[0]))].filter(Boolean);

    return {
      ...empty,
      command: sole ? pmRunText(pm, sole) : null,
      script: sole,
      authority: `\`${workflow.file}\`, the ${job.label || job.name} job`,
      steps: collapseSteps(expansion.steps),
      rawSteps: expansion.steps,
      commands: expansion.commands,
      parsed: expansion.parsed,
      unparsed: expansion.parsed ? null : (expansion.file ?? `${job.label} in ${workflow.file}`),
      stepFile: expansion.file,
      managersUsed: used,
      managerMismatch: used.some((manager) => manager !== pm),
      enforcement: enforcementScripts(scripts, expansion.steps),
    };
  }

  const scriptName = GATE_SCRIPT_NAMES.find((name) => typeof scripts[name] === 'string');
  if (!scriptName) return empty;

  const expansion = await expandGateScript(cwd, scripts[scriptName], scripts);
  const used = [...new Set(expansion.commands.map((c) => c.split(/\s+/)[0]))].filter(Boolean);

  return {
    ...empty,
    command: pmRunText(pm, scriptName),
    script: scriptName,
    authority: `the "${scriptName}" script in package.json`,
    steps: collapseSteps(expansion.steps),
    rawSteps: expansion.steps,
    commands: expansion.commands,
    parsed: expansion.parsed,
    unparsed: expansion.parsed ? null : (expansion.file ?? `the "${scriptName}" script`),
    stepFile: expansion.file,
    managersUsed: used,
    managerMismatch: used.some((manager) => manager !== pm),
    enforcement: enforcementScripts(scripts, expansion.steps),
  };
}

/** Named enforcement scripts, each marked with whether the gate demonstrably runs it. */
function enforcementScripts(scripts, gateSteps) {
  return Object.keys(scripts)
    .filter((name) => ENFORCEMENT_SCRIPT.test(name))
    .map((name) => ({ name, inGate: gateSteps.includes(name) }));
}

/**
 * Every validation command that can be read off this repository, best first.
 *
 * The manager comes from `detectPackageManager`, never a hardcoded `npm`. A repository that
 * installed with pnpm and a briefing that says `npm run verify` is not a formatting
 * difference: it tells the agent to run a command the project does not use, and in a repo
 * with no package-lock.json that command installs a second dependency tree instead of
 * checking anything.
 */
export async function detectValidationCommands(cwd, pkg, pm = 'npm') {
  const commands = [];
  const scripts = pkg?.scripts ?? {};

  // `pm run <name>` is correct whichever package manager installed the repo,
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
      commands.push({ label, command: pmRunText(pm, name), script: name });
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
export async function scanRepo(cwd, { exclude = null, pendingLocalExcludes = [] } = {}) {
  const { files, source } = await readFileIndex(cwd, { exclude });
  const pkg = await readJSONFile(path.join(cwd, 'package.json'));
  const entries = topLevelEntries(files);
  const packageManager = await detectPackageManager(cwd, pkg);

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

  // AGENTS.md is the file the briefing is written into, so it is never counted: the
  // number would otherwise go up by one the first time the briefing is committed, for no
  // reason a reader can account for. It is subtracted only when it is in the index — a
  // first --track run has not committed it yet, and subtracting it anyway undercounted.
  const agentsInIndex = files.includes(AGENTS_FILE);

  // Whether the briefing is (or is about to be) part of the repository is read from git,
  // not from a flag: it is in the index, or git would not ignore it once this run's own
  // .git/info/exclude lines are written. `--track` with a .gitignore that lists AGENTS.md
  // is still a local file, and saying otherwise tells an agent to stage the unstageable.
  const agentsTracked =
    agentsInIndex ||
    (source === 'git' &&
      !pendingLocalExcludes.includes(AGENTS_FILE) &&
      (await run('git', ['check-ignore', '-q', AGENTS_FILE], { cwd })).code === 1);

  const conventions = await detectConventions(cwd, files, pkg);

  return {
    cwd,
    files,
    fileSource: source,
    trackedCount: agentsInIndex ? files.length - 1 : files.length,
    agentsTracked,
    pkg,
    packageManager,
    projectName: pkg?.name ?? path.basename(cwd),
    projectDescription: typeof pkg?.description === 'string' ? pkg.description : null,
    entries,
    areas: areasOf(entries),
    rootFileEntries: entries.filter((entry) => !entry.isDir),
    exclude: exclude ? normalizeExclusions(exclude) : configuredExclusions(await readConfig(cwd)),
    branch: gitInfo.ok ? gitInfo.stdout.trim() : null,
    conventions,
    ignoredPatterns: await readIgnorePatterns(cwd),
    tests: detectTestCoverage(files, pkg, packageManager.name, conventions.runner),
    validation: await detectValidationCommands(cwd, pkg, packageManager.name),
    gate: await detectGate(cwd, pkg, packageManager.name),
    featureMap: detectFeatureMap(files, pkg),
    manifestEntryPoints: manifestEntryPoints(pkg),
    // Lines this run is about to add to .git/info/exclude, so a preview rendered before
    // the write says what the written file will say.
    pendingLocalExcludes,
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
 * The first few of a list, and a count of the rest.
 *
 * A warning's paths land in AGENTS.md, which an agent reads at the start of every session.
 * All 155 of a monorepo's test files cost thousands of tokens there and say nothing the
 * count and five examples do not; `paths` on the warning still carries the full list.
 */
export function someOf(items, shown = 5) {
  if (items.length <= shown) return items.join(', ');
  return `${items.slice(0, shown).join(', ')}, and ${items.length - shown} more`;
}

/**
 * The findings the briefing and the setup screen both have to say out loud.
 *
 * Two rules keep this list honest. A warning names paths that exist — no speculative
 * "check your .env" — and each one says what to do about it rather than only what it found.
 * `where` decides who says it: `briefing` findings are facts about the repository and go
 * into AGENTS.md, where an agent working alone will read them; `setup` findings are worth
 * a person's attention once and have no business being frozen into a file.
 */
export async function scanWarnings(facts) {
  const warnings = [];

  const tests = facts.tests;
  if (tests && tests.missed.length > 0) {
    warnings.push({
      id: 'tests-not-run',
      where: 'briefing',
      headline:
        `\`${tests.command}\` runs ${tests.targets.map((t) => `\`${t}\``).join(', ')}, ` +
        `and ${plural(tests.missed.length, 'tracked test file')} ${tests.missed.length === 1 ? 'is' : 'are'} outside it`,
      detail: someOf(tests.missed),
      paths: tests.missed,
    });
  }

  warnings.push(...(await detectVersionContradictions(facts)));
  warnings.push(...trackedSecretWarnings(facts));

  return warnings;
}

/** Every Node version this repository declares, and where it was declared. */
async function declaredNodeVersions(facts) {
  const declared = [];
  const majorsOf = (text) =>
    [...String(text).matchAll(/\d+/g)].map((match) => Number(match[0])).filter((n) => n >= 10 && n < 100);

  const engines = facts.pkg?.engines?.node ?? facts.pkg?.volta?.node;
  if (typeof engines === 'string') declared.push({ source: 'package.json engines.node', value: engines, majors: majorsOf(engines) });

  const nvmrc = await readFile(path.join(facts.cwd, '.nvmrc'), 'utf8').catch(() => null);
  if (nvmrc !== null && nvmrc.trim()) declared.push({ source: '.nvmrc', value: nvmrc.trim(), majors: majorsOf(nvmrc) });

  for (const file of ['.github/workflows/ci.yml', '.github/workflows/ci.yaml']) {
    const text = await readFile(path.join(facts.cwd, file), 'utf8').catch(() => null);
    if (text === null) continue;
    for (const match of text.matchAll(/node[-_]version\s*:\s*(.+)/g)) {
      declared.push({ source: `${file} node-version`, value: match[1].trim(), majors: majorsOf(match[1]) });
    }
  }

  return declared.filter((entry) => entry.majors.length > 0);
}

/**
 * README against package.json, .nvmrc and CI.
 *
 * These are four places the same fact is written, and nothing keeps them in step: a
 * contributor reads "requires Node >= 18" in the README, the CI matrix runs 20, and the
 * bug they file afterwards is "works on my machine" with a cause nobody wrote down. The
 * check is a set intersection on major versions, which is loose on purpose — it fires on
 * 18-versus-20 and stays quiet about the patch level.
 */
async function detectVersionContradictions(facts) {
  const readme = facts.files.find((file) => /^readme(\.md|\.rst|\.txt)?$/i.test(file));
  if (!readme) return [];

  const text = await readFile(path.join(facts.cwd, readme), 'utf8').catch(() => null);
  if (text === null) return [];

  const claimed = new Set();
  for (const match of text.matchAll(/node(?:\.?js)?\s*(?:version\s*)?(?:[>=^~]+\s*)?(\d+)(?:\.(\d+))?/gi)) {
    const major = Number(match[1]);
    if (major >= 10 && major < 100) claimed.add(major);
  }
  if (claimed.size === 0) return [];

  const declared = await declaredNodeVersions(facts);
  if (declared.length === 0) return [];

  const contradicting = declared.filter((entry) => !entry.majors.some((major) => claimed.has(major)));
  if (contradicting.length === 0) return [];

  return [
    {
      id: 'node-version-contradiction',
      where: 'setup',
      headline: `${readme} and the declared Node version disagree`,
      detail:
        `README claims Node ${[...claimed].sort((a, b) => a - b).join(', ')}; ` +
        `${contradicting.map((entry) => `${entry.source} says ${entry.value}`).join('; ')}`,
      paths: [readme, ...contradicting.map((entry) => entry.source)],
    },
  ];
}

/**
 * Credential-shaped files that are in the index.
 *
 * Path only, and that is the whole discipline: a warning that quoted the file would put
 * the secret in the terminal scrollback, in a support request, and in whatever the reader
 * pastes it into. A file matching an ignore pattern and tracked anyway was normally added
 * before the pattern existed or with `git add -f`, and it will not show up in a later
 * `git status` — which is why it is worth saying out loud at all.
 */
function trackedSecretWarnings(facts) {
  const secrets = facts.files.filter((file) => CREDENTIAL_PATTERN.test(file));
  if (secrets.length === 0) return [];

  const ignored = facts.ignoredPatterns?.credentials ?? [];
  const alsoIgnored = ignored.length > 0;

  return [
    {
      id: 'tracked-secret',
      where: 'setup',
      headline: `${plural(secrets.length, 'credential-shaped file')} ${secrets.length === 1 ? 'is' : 'are'} tracked in git`,
      detail:
        `${someOf(secrets)} — path only, contents not read.` +
        (alsoIgnored
          ? ` ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} in .gitignore, so ${secrets.length === 1 ? 'this file is' : 'these files are'} tracked from before the rule or added with -f, and will not appear in git status.`
          : ' Nothing in .gitignore covers them, so a new one will be added by accident.'),
      paths: secrets,
    },
  ];
}

/** Root files that declare a Python project's dependencies, and the lockfile that names its tool. */
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'];
const PYTHON_LOCKS = [
  ['uv.lock', 'uv'],
  ['poetry.lock', 'Poetry'],
  ['Pipfile.lock', 'Pipenv'],
];

/** The Python dependency line, from root files that exist; null when there are none. */
function pythonDependencies(files) {
  const declared = PYTHON_MANIFESTS.filter((name) => files.includes(name));
  if (declared.length === 0) return null;
  const lock = PYTHON_LOCKS.find(([name]) => files.includes(name));
  return (
    `Python dependencies: ${declared.map((name) => `\`${name}\``).join(', ')}` +
    (lock ? `, locked by \`${lock[0]}\` (${lock[1]}).` : '.')
  );
}

/** The tests line, naming the runner and what the script actually runs. */
function renderTests(facts) {
  const { conventions, tests } = facts;
  const parts = [];

  if (tests?.runner) parts.push(`runner ${tests.runner}`);

  const count = plural(tests?.total ?? conventions.testFiles, 'test file');
  const roots = (conventions.separateRoots ?? []).map((r) => `\`${r}/\``).join(', ');
  if (conventions.colocated) {
    parts.push(`${count} co-located with the source they test`);
  } else if (conventions.colocatedCount > 0 && conventions.separateCount > 0) {
    parts.push(`${count} (${conventions.colocatedCount} co-located with source, ${conventions.separateCount} under ${roots})`);
  } else if (conventions.testRoots.length > 0) {
    parts.push(`${count} (under ${conventions.testRoots.map((r) => `\`${r}/\``).join(', ')})`);
  } else {
    parts.push(count);
  }

  // What the script runs comes last, because it is the claim that has to be weighed
  // against the count: a count of two and a target of one directory is the gap the
  // warning below spells out.
  if (tests?.command && tests.targets.length > 0) {
    parts.push(`run by \`${tests.command}\` as ${tests.targets.map((t) => `\`${t}\``).join(', ')}`);
  } else if (tests?.command && tests?.openEnded) {
    parts.push(`\`${tests.command}\` names no path, so it discovers its own inputs`);
  }

  return `${parts.join(', ')}.`;
}

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
export function renderRootFiles(entries, facts = null) {
  const roots = entries.filter((entry) => !entry.isDir);
  if (roots.length === 0) return null;

  const names = roots.map((entry) => `\`${entry.name}\``).join(', ');
  const withEntries = roots
    .filter((entry) => entry.entryPoint)
    .map((entry) => `\`${entry.name}\``)
    .join(', ');

  const manifestEntry = facts.manifestEntryPoints[0] ?? null;

  if (manifestEntry && entries.some((entry) => entry.entryPoint === manifestEntry.value)) {
    // package.json names the entry point; that is a fact. A file called index.js is a guess.
    return (
      `Root files, none of which is an area of its own: ${names}.\n` +
      `The entry point is \`${manifestEntry.value}\` — package.json "${manifestEntry.field}".`
    );
  }

  return (
    `Root files, none of which is an area of its own: ${names}.` +
    (withEntries
      ? `\n${facts?.pkg ? 'package.json declares no entry point' : 'No manifest declares an entry point'}; ${withEntries} ${roots.filter((e) => e.entryPoint).length === 1 ? 'is' + ' named for one' : 'are named like one'}, which is a filename guess.`
      : '')
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
    push(value, `package.json "${field}" — what the project publishes or runs`);
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
  const { conventions, packageManager } = facts;
  const lines = [];

  const mix = languageMix(facts.files).slice(0, 4);
  if (mix.length > 0) {
    const total = mix.reduce((sum, item) => sum + item.count, 0);
    lines.push(
      `Language mix: ${mix.map((item) => `${item.label} ${item.count}`).join(', ')}` +
        ` (of ${total} files with a known extension).`,
    );
  }

  // A repository with no package.json has no Node package manager, and naming npm there
  // ("from no package.json, no lockfile") told a Python project every command used npm.
  if (packageManager && packageManager.source !== 'none') {
    // Said once, here, because every command further down depends on it and a reader who
    // pastes `npm run verify` into a pnpm repository gets a lockfile nobody asked for.
    lines.push(
      `Package manager: ${packageManager.name} (from ${packageManager.evidence}). ` +
        'Every command in this file uses it.',
    );
  }

  const python = pythonDependencies(facts.files);
  if (python) lines.push(python);

  if (conventions.moduleSystem) lines.push(`Modules: ${conventions.moduleSystem}.`);

  if (conventions.typescript) {
    const parts = [`TypeScript ${conventions.typescript.version.replace(/^[\^~]/, '')}`];
    parts.push(conventions.typescript.hasTsconfig ? 'tsconfig.json present' : 'no tsconfig.json');
    if (conventions.typescript.hasTsconfig) {
      parts.push(conventions.typescript.strict ? '"strict": true' : '"strict" is not set');
    }
    lines.push(`${parts.join(', ')}.`);
  }

  if (conventions.runner || conventions.testFiles > 0 || facts.tests?.total > 0) {
    lines.push(`Tests: ${renderTests(facts)}`);
  }

  if (conventions.eslintConfig) lines.push(`Lint: ESLint configured by \`${conventions.eslintConfig}\`.`);
  if (conventions.prettierConfig) {
    lines.push(`Format: Prettier configured by \`${conventions.prettierConfig}\`.`);
  }

  const aliases = conventions.aliases?.declared ?? [];
  if (aliases.length > 0) {
    // Rendered without backticks on the target: an alias target like "." or "src"
    // is a pattern, not a claim that the file "." exists, and the checker would
    // correctly report it as MISSING.
    const rendered = aliases.map((entry) => {
      const where = entry.files
        .map((file) => (entry.spellings?.[file] && entry.spellings[file] !== entry.alias ? `${file} as ${entry.spellings[file]}` : file))
        .join(', ');
      const gap =
        entry.absent.length > 0 ? ` — ${entry.absent.join(', ')} does not declare it` : '';
      return `${entry.alias} → ${entry.targets.join(', ')} (${where}${gap})`;
    });
    lines.push(`Import aliases: ${rendered.join('; ')}.`);

    if (conventions.aliases.files.length > 1) {
      lines.push(
        `Aliases are declared in ${plural(conventions.aliases.files.length, 'file')} ` +
          `(${conventions.aliases.files.join(', ')}), so a new one must be added to all ` +
          'of them: an alias one toolchain knows and another does not builds in Metro and ' +
          'fails in tsc, with neither tool naming the cause.',
      );
    }
  }

  if (conventions.mixedFolders.length > 0) {
    lines.push(
      `Not one module system throughout: ${conventions.mixedFolders
        .map((folder) => `\`${folder.folder}\` is ${folder.kind} (${folder.evidence})`)
        .join('; ')}.`,
    );
  }

  if (lines.length === 0) return null;
  return lines;
}

/** Ignore entries that name something whose contents must never be committed. */
const CREDENTIAL_PATTERN =
  /(keystore|jks|\.env|\.pem|\.p12|\.pfx|\.key|\.crt|\.cer|\.netrc|id_rsa|id_ed25519|credential|secret|token)/i;

/** Every ignore pattern a repository declares, split by what the pattern is for. */
export function parseIgnorePatterns(text) {
  const all = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  return {
    // A negation is a rule about what is tracked, and an agent that reads `!src/app.ts`
    // as "excluded" gets it backwards.
    all,
    negated: all.filter((line) => line.startsWith('!')),
    credentials: all.filter((line) => !line.startsWith('!') && CREDENTIAL_PATTERN.test(line)),
    ordinary: all.filter((line) => !line.startsWith('!') && !CREDENTIAL_PATTERN.test(line)),
  };
}

/** .gitignore, read whole rather than capped at the first few lines. */
async function readIgnorePatterns(cwd) {
  const raw = await readFile(path.join(cwd, '.gitignore'), 'utf8').catch(() => null);
  return raw === null ? null : parseIgnorePatterns(raw);
}

/**
 * `.git/info/exclude`, which is the one ignore file that never leaves the machine.
 *
 * Worth naming separately from .gitignore because the two are believed in opposite
 * directions: a teammate cloning the repository gets your .gitignore and none of your
 * local excludes, so a path that "is excluded" for you is tracked for them.
 */
async function readLocalExcludes(cwd) {
  const gitDir = await run('git', ['rev-parse', '--git-dir'], { cwd });
  if (!gitDir.ok) return [];

  const dir = gitDir.stdout.trim();
  const absolute = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
  const raw = await readFile(path.join(absolute, 'info', 'exclude'), 'utf8').catch(() => null);
  if (raw === null) return [];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * The boundaries this repository actually enforces, and the docs that say what they mean.
 *
 * A `verify:boundary:*` script is a boundary somebody wrote a rule for, and the rule is
 * almost never in the script: it is in the doc the script points at. Both are read, so the
 * section can say "auth cannot import from the payments folder, per docs/boundaries/auth.md"
 * instead of naming a script and leaving the reader to go find the rule.
 */
export async function detectEnforcedBoundaries(facts) {
  const scripts = facts.pkg?.scripts ?? {};
  // Every `verify:*` script, and anything named for a boundary, whatever its prefix — then
  // every `verify:*` step the gate runs that the manifest does not declare. Matching on the
  // word "boundary" alone missed `verify:boundaries` and every check named for what it
  // checks instead (`verify:licenses`), which is most of them.
  const gateSteps = facts.gate?.rawSteps ?? [];
  const names = [
    ...new Set([
      ...Object.keys(scripts).filter((name) => /^verify:/.test(name) || /boundar/i.test(name)),
      ...gateSteps.filter((step) => /^verify:/.test(step)),
    ]),
  ];
  const boundaries = [];

  for (const name of names) {
    const body = scripts[name];
    const file = body?.match(SCRIPT_DELEGATES_TO)?.[1]?.replace(/^\.\//, '') ?? null;
    const docs = [];

    if (file) {
      const text = await readFile(path.join(facts.cwd, file), 'utf8').catch(() => null);
      if (text !== null) {
        // A doc reference is read as a plain path token, not a backticked one: a script
        // says where the rule lives in a comment or a string, and requiring backticks
        // would miss most of them. Only tracked markdown counts — a path that is not in
        // the index is a stale reference, and sending a reader there wastes their turn.
        for (const token of text.matchAll(/[\w./@-]*[\w-]+\.md\b/g)) {
          const doc = token[0].replace(/^\.\//, '');
          if (!facts.files.includes(doc)) continue;
          if (!docs.includes(doc)) docs.push(doc);
        }
      }
    }

    boundaries.push({
      name,
      command: pmRunText(facts.packageManager?.name ?? 'npm', name),
      file,
      fileExists: Boolean(file) && facts.files.includes(file),
      // Only a gate NASO actually read can vouch for membership.
      inGate: Boolean(facts.gate?.parsed && gateSteps.includes(name)),
      hasGate: Boolean(facts.gate?.command),
      docs,
    });
  }

  return boundaries;
}

/**
 * The lines people cross by accident, stated as facts about this repository.
 *
 * Ordered by what an agent is most likely to get wrong, not by what the tooling happens to
 * know: the enforced boundaries first, because they are this repository's own rules and the
 * only thing here that can fail a commit; then the aliases, because an import that resolves
 * in one toolchain is the quietest failure there is; then the ignore rules, which are the
 * broadest and therefore the least surprising.
 *
 * Credential-shaped patterns are never abbreviated away. A `.gitignore` with forty entries
 * is a briefing sentence; one that silently drops `*.keystore` while listing `node_modules/`
 * is a lie about the repository's worst habit.
 */
async function renderBoundaries(facts) {
  const lines = [];
  const { conventions } = facts;

  const boundaries = await detectEnforcedBoundaries(facts);
  if (boundaries.length > 0) {
    // An unread gate makes membership unknown. Reporting every boundary script as
    // "not shown to run in the gate" in that case is a claim NASO cannot support:
    // the gate may well run all of them, and the section is read as an audit rather
    // than as a guess. It is the same reason an unparsed gate never claims a step
    // list.
    const gateUnknown = Boolean(facts.gate) && facts.gate.parsed === false;

    lines.push(
      `**Enforced checks.** ${plural(boundaries.length, 'verify or boundary script')} this repository ` +
        'declares or its gate runs, each with whether the gate runs it:',
    );
    if (gateUnknown) {
      lines.push(
        `The gate could not be read (${facts.gate.unparsed ?? 'the script it delegates to'}), ` +
          'so whether it runs these scripts is unknown. Read it before trusting a commit to be checked.',
      );
    }
    for (const boundary of boundaries) {
      const gate = gateUnknown
        ? 'gate membership unknown'
        : boundary.inGate
          ? 'runs in the gate'
          : boundary.hasGate
            ? 'not run by the gate'
            : 'no gate in this repository runs it';
      const target = boundary.file
        ? boundary.fileExists
          ? `checks \`${boundary.file}\``
          : // Not backticked: the briefing is reporting a broken reference, and a backticked
            // path here would read as a claim that the file exists — which the checker would
            // then correctly contradict.
            `names ${boundary.file}, which is not in the index`
        : 'could not be resolved to a file';
      const docs = boundary.docs.length > 0 ? `; the rule is in ${boundary.docs.map((d) => `\`${d}\``).join(', ')}` : '';
      lines.push(`- \`${boundary.name}\` (\`${boundary.command}\`) — ${target}, ${gate}${docs}.`);
    }
  }

  const declared = conventions.aliases?.declared ?? [];
  if (declared.length > 0) {
    lines.push(
      `**Import aliases.** ${declared.map((entry) => `${entry.alias} → ${entry.targets.join(', ')}`).join('; ')}. ` +
        'An import that uses a bare relative path where an alias exists is the one mistake ' +
        'TypeScript will not catch for you.',
    );
    if (conventions.aliases.files.length > 1) {
      const missing = conventions.aliases.divergent;
      lines.push(
        `Declared in ${conventions.aliases.files.join(', ')}. A new alias must go in all of ` +
          'them, or it resolves in one toolchain and not the other.' +
          (missing.length > 0
            ? ` Already divergent: ${missing.map((entry) => `${entry.alias} (missing from ${entry.absent.join(', ')})`).join('; ')}.`
            : ''),
      );
    }
  }

  if (Array.isArray(conventions.eslintIgnores) && conventions.eslintIgnores.length > 0) {
    // Not backticked: these are glob patterns, not paths that must exist.
    lines.push(
      `**Lint.** ESLint ignores ${conventions.eslintIgnores.join(', ')} — lint passes there ` +
        'because nothing is checked, not because the code is correct.',
    );
  }

  const ignored = await readIgnorePatterns(facts.cwd);
  if (ignored) {
    if (ignored.credentials.length > 0) {
      lines.push(
        `**Credentials.** .gitignore excludes ${ignored.credentials.join(', ')}. A file matching ` +
          'one of these is never committed, which means a real key there is invisible to ' +
          '`git status` — look for it before assuming a build failure is unrelated.',
      );
    }

    const shown = ignored.ordinary.slice(0, 10);
    const elided = ignored.ordinary.length - shown.length;
    if (shown.length > 0) {
      lines.push(
        `**Ignored paths.** Nothing under ${shown.join(', ')} reaches a commit, and nothing ` +
          `under ${shown.length === 1 ? 'it is' : 'them is'} reviewed.` +
          (elided > 0 ? ` ${elided} further pattern${elided === 1 ? '' : 's'} in .gitignore ${elided === 1 ? 'is' : 'are'} not listed here.` : ''),
      );
    }

    if (ignored.negated.length > 0) {
      lines.push(
        `**Re-included.** ${ignored.negated.join(', ')} — a negated pattern means those paths ` +
          'are tracked after all, whatever sits above them.',
      );
    }
  }

  const local = [...new Set([...(await readLocalExcludes(facts.cwd)), ...(facts.pendingLocalExcludes ?? [])])];
  if (local.length > 0) {
    lines.push(
      `**Local excludes.** .git/info/exclude holds ${local.join(', ')} on this machine only. ` +
        'Nobody else has them: a teammate cloning this repository gets none of these paths ' +
        'excluded, so do not reason about them as if they were shared policy.',
    );
  }

  if (lines.length === 0) return null;
  return lines;
}

/**
 * Rule 8, which depends on whether this file is in the index.
 *
 * The old wording told every reader to stage the line the hook appends, in a repository
 * where the default run leaves AGENTS.md out of git entirely — so it described a commit
 * that could not be made, and invited an agent to `git add -f` a file the user chose to
 * keep local. Two different situations, two different rules, chosen from the index rather
 * than from a flag: tracked means the briefing is reviewed like any other file and the
 * appended line belongs in the commit; untracked means it never is.
 */
function commitStandardRule8(facts) {
  if (facts.agentsTracked) {
    return (
      '8. When a commit adds a genuinely new area, the hook appends one line for it\n' +
      '   above and stages it with the commit. This file is tracked, so it is reviewed\n' +
      '   like any other: if the hook reports it unstaged, that is a finding to fix.'
    );
  }

  return (
    '8. This file is not in the index and never will be: it is local to this machine,\n' +
    '   excluded through .git/info/exclude so setup leaves no trace in the history. Do\n' +
    '   not stage it, do not `git add -f` it, and do not mention it in a commit message.\n' +
    '   The line the hook appends for a new area stays unstaged and is reported; every\n' +
    "   teammate's briefing is generated from their own scan of their own checkout."
  );
}

/**
 * Render the whole briefing.
 *
 * Sections that derive nothing are omitted rather than left as an invitation to
 * fill them in later — an empty heading reads as a section someone forgot, and
 * an agent that trusts the file will waste a turn looking for content that is
 * not coming.
 */
/**
 * How the counts in this file were arrived at, stated once, at the top.
 *
 * A count without its provenance is the failure this whole tool exists to prevent, so the
 * header says which list it came from rather than leaving it to be assumed. In a git
 * repository that is the index, so nothing in an ignored build directory can be in it; on a
 * directory git does not manage it is a filesystem walk, which is a weaker claim, and the
 * reader is told so instead of being handed a number that quietly includes node_modules.
 */
export function countPhrase(facts) {
  return facts.fileSource === 'git'
    ? plural(facts.trackedCount, 'tracked file')
    : `${plural(facts.trackedCount, 'file')} on disk`;
}

export function countProvenance(facts) {
  return facts.fileSource === 'git'
    ? `${plural(facts.trackedCount, 'tracked file')}, excluding AGENTS.md`
    : `${plural(facts.trackedCount, 'file')} on disk - this directory is not a git repository, ` +
        'so these counts come from a filesystem walk and include anything in ignored build output';
}

/**
 * The validation section: one gate and what it subsumes.
 *
 * The previous version listed `lint`, `typecheck`, `test` and `verify` as four peers, which
 * is wrong in a way that costs real time — on a repository where `verify` runs the first
 * three, an agent following the list runs the whole suite twice and has no idea which
 * single command the project considers the answer.
 *
 * So: the gate is named once, what it subsumes is listed as prose under it, and the
 * scripts it demonstrably runs are never repeated as peers. Only commands the gate does
 * *not* cover get their own line, because those are the ones that still have to be run by
 * hand and the briefing is the only place that can say so.
 *
 * When there is no gate at all — no workflow job, no verify/check/ci script — the section
 * degrades to the plain list. Inventing an authoritative command for a repository that
 * never named one is the failure this tool exists to prevent.
 */
export function renderValidation(facts) {
  const { gate, validation } = facts;

  if (!gate || !gate.command) {
    if (validation.length === 0) return null;
    return (
      `### Validation commands\n\nThis repository names no single gate. These are the ` +
      `commands it declares:\n\n\`\`\`bash\n${validation.map((c) => c.command).join('\n')}\n\`\`\``
    );
  }

  const lines = [`### Validation commands\n`];
  lines.push(`One gate: \`${gate.command}\` — the authority is ${gate.authority}.`);

  if (gate.unparsed) {
    lines.push(
      `**WARN** The gate could not be parsed; see \`${gate.unparsed}\`. Read it before ` +
        'trusting what this file says the gate covers — NASO will not guess.',
    );
  } else if (gate.steps.length > 0) {
    const from = gate.stepFile ? `read from \`${gate.stepFile}\`` : 'read from the script body';
    lines.push(`It runs, in order (${from}): ${gate.steps.join(', ')}.`);
  }

  if (gate.managerMismatch) {
    lines.push(
      `**WARN** The gate invokes ${gate.managersUsed.join(', ')} internally while this ` +
        'repository installs with a different manager, so it may resolve binaries it did ' +
        'not install. Run it and read what it prints.',
    );
  }

  if (gate.enforcement.length > 0) {
    lines.push(
      `Checks this repository names: ${gate.enforcement
        .map((entry) => `\`${entry.name}\` — ${entry.inGate ? 'in the gate' : 'no sign it is in the gate'}`)
        .join('; ')}.`,
    );
  }

  const covered = new Set(gate.rawSteps ?? []);
  const others = validation.filter(
    (command) => command.script !== gate.script && !covered.has(command.script),
  );
  if (others.length > 0) {
    lines.push(
      `Not run by the gate, so still yours to run: ${others
        .map((command) => `\`${command.command}\``)
        .join(', ')}.`,
    );
  }

  return lines.join('\n\n');
}

export async function renderBriefing(facts, { version, now }) {
  const parts = [];

  parts.push(
    `${NASO_START}\n${TEMPLATE_HEADER.replace('__VERSION__', version).replace('__DATE__', now)}`,
  );

  parts.push(`# ${facts.projectName} — Agent Instructions`);
  parts.push(`> Generated by NASO ${version} on ${now} from the ${countProvenance(facts)}.
> Every path below was read while this file was written, and every count is a count.
> Where NASO could not derive a fact, the section is absent rather than guessed at.
>
> Maintained through normal code review. NASO never regenerates this file
> wholesale; the pre-commit hook appends at most one line per genuinely new area.`);

  const dirs = facts.areas;
  const rootFiles = renderRootFiles(facts.entries, facts);
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
  const warnings = (await scanWarnings(facts)).filter((warning) => warning.where === 'briefing');
  const warningText = warnings.length
    ? `\n\n${warnings.map((w) => `**WARN** ${w.headline}: ${w.detail}. Tracked files read as covered; nothing runs them unless the script names them.`).join('\n\n')}`
    : '';

  if (conventions) {
    const validation = renderValidation(facts);
    parts.push(`## Code Conventions\n\n${conventions.join('\n')}${warningText}${validation ? `\n\n${validation}` : ''}`);
  } else if (renderValidation(facts)) {
    parts.push(`## Validation\n\n${renderValidation(facts)}${warningText}`);
  } else if (warningText) {
    parts.push(`## Validation\n\n${warningText.trim()}`);
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
${commitStandardRule8(facts)}`);

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
  // Only the NASO block is NASO's claim. Text around it is the owner's, and a hand-written
  // rule like "scope commits to `web` or `mobile`" names areas, not files — checking it as
  // paths failed a fresh setup on every repository whose own AGENTS.md used backticks.
  const start = briefing.indexOf(NASO_START);
  const end = briefing.indexOf(NASO_END);
  const claimed = start !== -1 && end > start ? briefing.slice(start, end) : briefing;
  const tokens = extractPathTokens(claimed);
  const entries = await listTopLevelEntries(cwd);

  const missing = [];
  for (const token of tokens) {
    if (!(await pathExists(path.join(cwd, token)))) missing.push(token);
  }

  const uncovered = findUncovered(entries, claimed);

  const markerCounts = MARKERS.map((marker) => ({
    marker,
    count: (claimed.match(new RegExp(escapeRegExp(marker), 'g')) ?? []).length,
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
  const now = new Date().toISOString().slice(0, 10);

  const outcome = await withLock(
    cwd,
    async () => {
      const before = await readFile(agentsPath, 'utf8').catch(() => null);
      const existingLines = before === null ? 0 : before.split('\n').length;

      const facts = await scanRepo(cwd, { exclude });
      const block = await renderBriefing(facts, { version, now });

      if (before === null) {
        await writeFile(agentsPath, block, 'utf8');
        return { ok: true, appended: false, agentsPath, content: block, facts };
      }

      const start = before.indexOf(NASO_START);
      const end = before.indexOf(NASO_END);

      if (start === -1 || end === -1 || end < start) {
        // No block of ours in the file: append one and keep every existing line.
        const appended = appendBlock(before, block);
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

/**
 * A hand-written AGENTS.md with the NASO block appended, every existing byte kept.
 *
 * One function for the write and for the plan's line count, so the preview cannot
 * disagree with the file about how much was added.
 */
export function appendBlock(before, block) {
  const separator =
    before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${block}`;
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
          : `Wrote ${AGENTS_FILE} from ${countPhrase(result.facts)}.`,
    );
    console.log('');
    for (const entry of result.facts.areas) {
      console.log(`  ${describeEntry(entry)}`);
    }
    const rootFiles = renderRootFiles(result.facts.entries, result.facts);
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
