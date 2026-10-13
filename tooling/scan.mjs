// NASO scan — read the repository into facts: areas, entry points, conventions, tests,
// the gate, history. Nothing here writes, and nothing here decides wording.
//
// Zero external dependencies — Node.js core modules only.

import {
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  readJSONFile,
  run,
  detectPackageManager,
  pmRunText,
  isNoisyDir,
} from './lib.mjs';
import {
  LOCK_FILENAME,
} from './lock.mjs';
import {
  readConfig,
  configuredExclusions,
  normalizeExclusions,
  isExcluded,
} from './vendor.mjs';

/** The briefing file's name, for modules that report on it. */
export const AGENTS_FILE = 'AGENTS.md';

/**
 * The two markers that delimit everything NASO owns inside AGENTS.md.
 *
 * Exported rather than re-declared per module because `setup`, `refresh` and the
 * pre-commit append all have to agree on them exactly: a marker spelled two ways is an
 * append that lands outside the block and a refresh that rewrites somebody's prose.
 */
export const NASO_START = '<!-- naso:start -->';
export const NASO_END = '<!-- naso:end -->';

export const TEMPLATE_HEADER = `<!-- naso-briefing -->
<!-- version: __VERSION__ -->
<!-- generated-at: __DATE__ -->`;

export const AUTO_START = '<!-- naso:auto:start -->';
export const AUTO_END = '<!-- naso:auto:end -->';

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

/**
 * Basenames that mark a file as the way into an area.
 *
 * `lib` only for Rust, where `lib.rs` is the crate root by rule. Anywhere else a file
 * called lib is the shared helpers, and naming it the entry sent readers to the one file
 * that explains nothing about how the area is used.
 */
const ENTRY_BASENAME = /^(index|main|app|server|mod|__init__|__main__|entry|cli)\.[a-z]+$|^lib\.rs$/i;

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
        ? has('typescript')
          ? typescriptModuleLine(files)
          : 'CommonJS by default (no "type": "module")'
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

/**
 * The module line for TypeScript with no "type" field.
 *
 * "CommonJS by default" is true of the `.js` config files beside package.json and false of
 * the `.ts` source, which is written with `import` and compiled by tsc, Babel or Metro.
 * Read as a statement about the whole repository it sent agents to write `require`.
 */
function typescriptModuleLine(files) {
  const rootJs = files.filter((file) => !file.includes('/') && file.endsWith('.js'));
  return (
    // Not backticked: the checker reads `.js` and `import` as paths that must exist.
    '.js files are CommonJS (no "type": "module")' +
    (rootJs.length > 0 ? `, which covers ${rootJs.map((file) => `\`${file}\``).join(', ')}` : '') +
    '; TypeScript source is compiled by its toolchain and uses import syntax whatever this says'
  );
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

/** Relative module specifiers in a file: static and literal dynamic imports, and require. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm;

/**
 * The top-level areas one file imports from, one hop deep.
 *
 * Literal specifiers only. A path built at runtime is not read, so an area loaded that way
 * keeps its name-based role — less precise, but never a claim the code does not make.
 */
export async function importedAreas(cwd, file) {
  const text = await readFile(path.join(cwd, file), 'utf8').catch(() => null);
  if (text === null) return [];
  const areas = new Set();
  for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
    if (target.startsWith('..')) continue;
    const [area, ...rest] = target.split('/');
    if (rest.length > 0) areas.add(area);
  }
  return [...areas].sort();
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

/** Top-level keys in .gitlab-ci.yml that configure the pipeline rather than name a job. */
const GITLAB_KEYWORDS = new Set([
  'stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'cache',
  'before_script', 'after_script', 'types',
]);

/**
 * The jobs in a .gitlab-ci.yml, with the commands each one's `script:` runs.
 *
 * Same contract as `parseWorkflowJobs`, and hand-rolled for the same reason. A GitLab job
 * is any top-level key that is not a keyword and does not start with a dot (a dot is a
 * template other jobs `extends`). Only `script:` is read: `before_script:` is setup such as
 * `npm ci`, and a gate listed with its install step reads as a check that installs things.
 * The inline, list and `- |` block forms are understood; a job written some other way
 * yields no commands and is left out, never guessed at.
 */
export function parseGitlabJobs(text) {
  const jobs = [];
  let job = null;
  let scriptIndent = -1;
  let blockIndent = -1;

  const note = (value) => {
    if (job) job.commands.push(...extractInvocations(value));
  };

  for (const raw of String(text).split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      const key = raw.match(/^([^\s#][^:]*):/)?.[1]?.trim().replace(/^["']|["']$/g, '');
      job = key && !key.startsWith('.') && !GITLAB_KEYWORDS.has(key) ? { name: key, label: key, commands: [] } : null;
      if (job) jobs.push(job);
      scriptIndent = -1;
      blockIndent = -1;
      continue;
    }
    if (!job) continue;

    if (blockIndent >= 0) {
      if (indent > blockIndent) {
        note(raw);
        continue;
      }
      blockIndent = -1;
    }

    if (scriptIndent >= 0) {
      if (indent > scriptIndent || (indent === scriptIndent && raw.trimStart().startsWith('-'))) {
        const item = raw.trimStart().replace(/^-\s*/, '');
        if (/^[|>][-+]?\s*$/.test(item)) blockIndent = indent;
        else note(item.replace(/^["']|["']$/g, ''));
        continue;
      }
      scriptIndent = -1;
    }

    const script = raw.match(/^(\s+)script:\s*(.*?)\s*$/);
    if (!script) continue;
    const value = script[2];
    if (value === '') {
      scriptIndent = script[1].length;
    } else if (value.startsWith('[')) {
      for (const item of value.replace(/^\[|\]$/g, '').split(',')) note(item.trim().replace(/^["']|["']$/g, ''));
    } else {
      note(value.replace(/^["']|["']$/g, ''));
    }
  }

  return jobs.filter((entry) => entry.commands.length > 0);
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
export const SCRIPT_DELEGATES_TO = /(?:^|\s)(?:node|tsx|babel-node|bash|sh|zsh|python3?)\s+([\w./@-]+\.(?:mjs|cjs|js|ts|sh))\b/;

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
    ciFile: null,
    jobs: [],
    external: false,
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
      ciFile: workflow.file,
      jobs: [{ name: job.label || job.name, commands: job.commands }],
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

  // GitLab runs a pipeline of jobs, one check each, rather than one job that runs them
  // all. There is then no single local command that is the gate, and the briefing lists
  // the jobs instead. Reading only .github/ told a GitLab repository it named no gate.
  const gitlab = await readFile(path.join(cwd, '.gitlab-ci.yml'), 'utf8').catch(() => null);
  const gitlabJobs = gitlab === null ? [] : parseGitlabJobs(gitlab);
  if (gitlabJobs.length > 0) {
    const commands = [...new Set(gitlabJobs.flatMap((job) => job.commands))];
    const steps = commands.map((command) => labelForInvocation(command, scripts));
    const used = [...new Set(commands.map((c) => c.split(/\s+/)[0]))].filter(Boolean);
    return {
      ...empty,
      authority: '`.gitlab-ci.yml`',
      ciFile: '.gitlab-ci.yml',
      jobs: gitlabJobs.map((job) => ({ name: job.name, commands: job.commands })),
      // An `include:` pulls jobs from another project or file, which this scan cannot
      // see. Said in the briefing so the job list is not read as the whole pipeline.
      external: /^include:/m.test(gitlab),
      steps: collapseSteps(steps),
      rawSteps: steps,
      commands,
      managersUsed: used,
      managerMismatch: used.some((manager) => /^(?:npm|pnpm|yarn|bun)$/.test(manager) && manager !== pm),
      enforcement: enforcementScripts(scripts, steps),
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
/** A script body that changes files instead of reporting on them. */
const REWRITES = /--write\b|--fix\b|(?:^|\s)-w(?:\s|$)/;

/**
 * Scripts named like checks that rewrite files instead: `format: prettier --write .`.
 *
 * Kept out of the validation list. An agent told to "run the validation commands" that
 * runs one of these reformats the repository and reports a pass, which is the opposite of
 * finding out whether the code was already right.
 */
export function detectRewritingScripts(pkg, pm = 'npm') {
  const scripts = pkg?.scripts ?? {};
  return ['lint', 'format']
    .filter((name) => typeof scripts[name] === 'string' && REWRITES.test(scripts[name]))
    .map((name) => ({ script: name, command: pmRunText(pm, name), body: scripts[name] }));
}

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
    ['format:check', 'Format check'],
    ['format', 'Format'],
    ['build', 'Build'],
  ];
  for (const [name, label] of ORDER) {
    if (typeof scripts[name] === 'string' && !REWRITES.test(scripts[name])) {
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
  const published = manifestEntryPoints(pkg).filter((point) => point.field === 'bin');

  for (const entry of entries) {
    entry.manifest = await manifestFor(cwd, entry);
    entry.entryPoint = entryPointOf(entry);
    entry.language = dominantLanguage(entry.files);
    entry.testFiles = entry.files.filter((f) => TEST_FILE.test(f)).length;
    // Resolved once, here, so the generator, the pre-commit append and the guide
    // can never disagree about which areas are named and which are not.
    entry.role = roleFor(entry.name) ?? (entry.manifest ? ROLE_BY_MANIFEST.get(entry.manifest) ?? null : null);
    // The manifest outranks the name. `bin/` reads as "developer scripts", but when
    // package.json "bin" points into it, it is what the package ships to every user.
    if (entry.isDir && published.some((point) => point.value.startsWith(`${entry.name}/`))) {
      entry.role = 'published command (package.json "bin")';
    }
  }

  // A folder name is a guess; an import from the published entry is a fact. NASO's own
  // `tooling/` read as "developer scripts" although it is everything the command runs.
  // Only a generic or missing role is replaced: "application source" was already right.
  for (const point of manifestEntryPoints(pkg)) {
    for (const area of await importedAreas(cwd, point.value)) {
      const entry = entries.find((candidate) => candidate.isDir && candidate.name === area);
      if (!entry || (entry.role && entry.role !== 'developer scripts')) continue;
      if (point.value.startsWith(`${area}/`)) continue;
      const what = point.field === 'bin' ? 'the published command' : 'the package entry';
      entry.role = `code ${what} loads (\`${point.value}\` imports it)`;
    }
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
    history: await readCommitHistory(cwd),
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
    rewriters: detectRewritingScripts(pkg, packageManager.name),
    gate: await detectGate(cwd, pkg, packageManager.name),
    featureMap: detectFeatureMap(files, pkg),
    manifestEntryPoints: manifestEntryPoints(pkg),
    // Lines this run is about to add to .git/info/exclude, so a preview rendered before
    // the write says what the written file will say.
    pendingLocalExcludes,
  };
}


export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How many commits the commit standard is read from. */
const HISTORY_DEPTH = 50;

/** Fewer commits than this is not a habit, and the standard says nothing about style. */
export const HISTORY_MINIMUM = 5;

// Type, optional scope, then an optional ticket key: `feat: SCRUM-12: x` is a different
// convention from `feat(auth): x`, and stating one where the history uses the other gets
// commits rejected by whatever push rule enforces it.
const CONVENTIONAL_SUBJECT = /^([a-z]+)(\([^)]+\))?!?: (?:([A-Z][A-Z0-9]+)-\d+:? )?\S/;

/**
 * What the repository's own recent history says about how commits are written.
 *
 * The old Commit Standard handed every repository the same seven rules, conventional
 * subjects included, whatever its history looked like. Here the subject format is stated
 * only when most recent commits already follow it, and the co-author rule only when no
 * recent commit carries a trailer — a repository that does is not told to stop.
 */
export async function readCommitHistory(cwd) {
  const res = await run(
    'git',
    ['log', `-${HISTORY_DEPTH}`, '--no-merges', '--format=%s%x1f%(trailers:key=Co-authored-by,valueonly)%x1e'],
    { cwd },
  );
  if (!res.ok) return { count: 0, conventional: 0, scoped: 0, ticketed: 0, ticketKey: null, types: [], coAuthored: 0 };
  const commits = res.stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject, trailers = ''] = record.split('\x1f');
      return { subject, coAuthored: trailers.trim().length > 0 };
    });

  const counts = new Map();
  const keys = new Map();
  let conventional = 0;
  let scoped = 0;
  let ticketed = 0;
  for (const { subject } of commits) {
    const match = CONVENTIONAL_SUBJECT.exec(subject);
    if (!match) continue;
    conventional += 1;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    if (match[2]) scoped += 1;
    if (match[3]) {
      ticketed += 1;
      keys.set(match[3], (keys.get(match[3]) ?? 0) + 1);
    }
  }
  const byCount = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  const types = byCount(counts);

  return {
    count: commits.length,
    conventional,
    scoped,
    ticketed,
    ticketKey: byCount(keys)[0] ?? null,
    types,
    coAuthored: commits.filter((commit) => commit.coAuthored).length,
  };
}


/** Ignore entries that name something whose contents must never be committed. */
export const CREDENTIAL_PATTERN =
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
export async function readIgnorePatterns(cwd) {
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
export async function readLocalExcludes(cwd) {
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
