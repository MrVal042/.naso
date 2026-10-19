// NASO toolchain — facts about how this repository builds, formats, tests and merges, read
// from the file that states each one.
//
// Every one of these was added by hand in the field, by an agent that had to open the file
// NASO could have read: Prettier's options, Jest's preset and module mocks, Expo's runtime
// version policy and experiments, Metro's transformers, the items on the merge request
// checklist, CONTRIBUTING's merge mode and the exceptions to its commit rule, and the files
// a framework writes and git ignores. Each fact keeps its file, and its line where it has
// one, so the block can cite it and the checker can test the citation.
//
// Config written in JavaScript or TypeScript is read, never run: a regular expression over
// the text finds the literal values, and a value built at runtime is simply not reported.
//
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './lib.mjs';

const read = (cwd, file) => readFile(path.join(cwd, file), 'utf8').catch(() => null);

/** JSON that may carry comments and trailing commas, as tsconfig and .prettierrc often do. */
function parseLoose(text) {
  try {
    return JSON.parse(
      String(text)
        .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (match, comment) => (comment ? '' : match))
        .replace(/,(\s*[}\]])/g, '$1'),
    );
  } catch {
    return null;
  }
}

/** A sentence for quoting: list and checkbox markers, emphasis and code ticks removed, curly quotes made straight. */
export function quotable(line) {
  return String(line)
    .replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/`|\*\*|__/g, '')
    .replace(/[“”]/g, '"')
    .trim();
}

// ---------------------------------------------------------------------------
// Prettier
// ---------------------------------------------------------------------------

/** The options that change what a line of code looks like; plugins and overrides are left to the file. */
const PRETTIER_OPTIONS = ['printWidth', 'tabWidth', 'useTabs', 'semi', 'singleQuote', 'jsxSingleQuote', 'quoteProps', 'trailingComma', 'bracketSpacing', 'bracketSameLine', 'arrowParens', 'endOfLine', 'proseWrap'];

const PRETTIER_FILES = ['.prettierrc', '.prettierrc.json', '.prettierrc.json5', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts'];

/** `{ source, options: [[name, value]] }` from the Prettier config or package.json "prettier", or null. */
export async function readPrettier(cwd, files, pkg) {
  let source = null;
  let config = null;
  for (const name of PRETTIER_FILES.filter((file) => files.includes(file))) {
    const text = (await read(cwd, name)) ?? '';
    source = name;
    if (/\.(?:json5?)$|^\.prettierrc$/.test(name)) config = parseLoose(text) ?? (name === '.prettierrc' ? yamlOptions(text) : null);
    else if (/\.ya?ml$/.test(name)) config = yamlOptions(text);
    else config = scriptOptions(text);
    break;
  }
  if (!source && pkg?.prettier && typeof pkg.prettier === 'object') {
    source = 'package.json "prettier"';
    config = pkg.prettier;
  }
  if (!source) return null;
  const options = PRETTIER_OPTIONS.filter((name) => config && config[name] !== undefined).map((name) => [name, config[name]]);
  return { source, options };
}

function yamlOptions(text) {
  const out = {};
  for (const match of String(text).matchAll(/^(\w+)\s*:\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm)) out[match[1]] = literal(match[2]);
  return out;
}

function scriptOptions(text) {
  const out = {};
  for (const name of PRETTIER_OPTIONS) {
    const match = String(text).match(new RegExp(`\\b${name}\\s*:\\s*(true|false|\\d+|'[^']*'|"[^"]*")`));
    if (match) out[name] = literal(match[1]);
  }
  return out;
}

const literal = (raw) => {
  const value = String(raw).trim().replace(/^['"]|['"]$/g, '');
  return value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number(value) : value;
};

// ---------------------------------------------------------------------------
// Jest
// ---------------------------------------------------------------------------

const JEST_FILES = ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json'];

/** `{ source, preset, mappers: [[pattern, target]], setup: [files] }`, or null without a Jest config. */
export async function readJest(cwd, files, pkg) {
  const name = JEST_FILES.find((file) => files.includes(file));
  let source = null;
  let preset = null;
  let mappers = [];
  let setup = [];
  if (name) {
    source = name;
    const text = (await read(cwd, name)) ?? '';
    const json = name.endsWith('.json') ? parseLoose(text) : null;
    if (json) {
      preset = json.preset ?? null;
      mappers = Object.entries(json.moduleNameMapper ?? {});
      setup = [...(json.setupFiles ?? []), ...(json.setupFilesAfterEnv ?? [])];
    } else {
      preset = text.match(/\bpreset\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
      const block = text.match(/\bmoduleNameMapper\s*:\s*\{([\s\S]*?)\}/)?.[1] ?? '';
      mappers = [...block.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map((match) => [match[1], match[2]]);
      const files = text.match(/\bsetupFiles(?:AfterEnv)?\s*:\s*\[([^\]]*)\]/g) ?? [];
      setup = files.flatMap((entry) => [...entry.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]));
    }
  } else if (pkg?.jest && typeof pkg.jest === 'object') {
    source = 'package.json "jest"';
    preset = pkg.jest.preset ?? null;
    mappers = Object.entries(pkg.jest.moduleNameMapper ?? {});
    setup = [...(pkg.jest.setupFiles ?? []), ...(pkg.jest.setupFilesAfterEnv ?? [])];
  }
  if (!source || (!preset && mappers.length === 0 && setup.length === 0)) return null;
  return { source, preset, mappers: mappers.map(([from, to]) => [from, Array.isArray(to) ? to.join(', ') : String(to)]), setup };
}

// ---------------------------------------------------------------------------
// Expo and Metro
// ---------------------------------------------------------------------------

const EXPO_CONFIGS = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs', 'app.json'];

/** What each runtime version policy asks of a person when native code changes. */
const RUNTIME_POLICY = {
  appVersion: 'bump `version` there whenever native code changes, or an update reaches builds that cannot run it',
  nativeVersion: 'bump `version` or the native build number whenever native code changes, or an update reaches builds that cannot run it',
  sdkVersion: 'it moves with the Expo SDK, so a native change inside one SDK needs a new build, not an update',
  fingerprint: 'it is computed from the native code, so it changes by itself; never set it by hand',
};

/** What an Expo experiment changes for code written here. */
const EXPERIMENTS = {
  typedRoutes: 'route hrefs are type-checked against the files under the router',
  reactCompiler: 'React Compiler memoises components; do not add useMemo or useCallback by habit',
  tsconfigPaths: 'Metro resolves the tsconfig paths aliases',
  baseUrl: 'the web build is served under a base URL',
};

/** `{ source, runtime: { policy } | { fixed }, experiments: [name] }`, or null. */
export async function readExpo(cwd, files, pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (!deps.expo) return null;
  for (const name of EXPO_CONFIGS.filter((file) => files.includes(file))) {
    const text = (await read(cwd, name)) ?? '';
    let runtime = null;
    let experiments = [];
    if (name.endsWith('.json')) {
      const expo = parseLoose(text)?.expo ?? parseLoose(text) ?? {};
      if (typeof expo.runtimeVersion === 'string') runtime = { fixed: expo.runtimeVersion };
      else if (expo.runtimeVersion?.policy) runtime = { policy: expo.runtimeVersion.policy };
      experiments = Object.entries(expo.experiments ?? {}).filter(([, on]) => on === true).map(([key]) => key);
    } else {
      const policy = text.match(/\bruntimeVersion\s*:\s*\{[^}]*\bpolicy\s*:\s*['"](\w+)['"]/)?.[1];
      const fixed = text.match(/\bruntimeVersion\s*:\s*['"]([^'"]+)['"]/)?.[1];
      runtime = policy ? { policy } : fixed ? { fixed } : null;
      const block = text.match(/\bexperiments\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
      experiments = [...block.matchAll(/(\w+)\s*:\s*true\b/g)].map((match) => match[1]);
    }
    if (runtime || experiments.length > 0) return { source: name, runtime, experiments };
  }
  return null;
}

/** `{ source, transformer, svg }` when metro.config.* swaps Babel's transformer, or null. */
export async function readMetro(cwd, files) {
  const name = ['metro.config.js', 'metro.config.cjs', 'metro.config.mjs', 'metro.config.ts'].find((file) => files.includes(file));
  if (!name) return null;
  const text = (await read(cwd, name)) ?? '';
  const transformer = text.match(/babelTransformerPath\s*[:=]\s*require\.resolve\(\s*['"]([^'"]+)['"]/)?.[1] ?? (text.match(/['"](react-native-svg-transformer[^'"]*)['"]/)?.[1] ?? null);
  if (!transformer) return null;
  return { source: name, transformer, svg: /svg/i.test(transformer) };
}

// ---------------------------------------------------------------------------
// Files a framework writes and git ignores
// ---------------------------------------------------------------------------

const FRAMEWORK_FILES = [
  { dep: 'expo', by: 'Expo (`npx expo start` or `npx expo customize tsconfig.json`)', paths: ['.expo/', 'expo-env.d.ts'] },
  { dep: 'next', by: 'Next.js (`next dev` or `next build`)', paths: ['.next/', 'next-env.d.ts'] },
  { dep: 'astro', by: 'Astro (`astro sync`)', paths: ['.astro/'] },
  { dep: '@sveltejs/kit', by: 'SvelteKit (`svelte-kit sync`)', paths: ['.svelte-kit/'] },
  { dep: 'nuxt', by: 'Nuxt (`nuxi prepare`)', paths: ['.nuxt/'] },
];

/**
 * `[{ by, paths, typecheck }]`: what a framework generates that .gitignore keeps out, and
 * whether type-checking needs it. tsconfig "include" is a list of patterns, and a pattern
 * that matches nothing is not an error, so a fresh clone type-checks without those files;
 * a path in "files" that is missing fails `tsc`.
 */
export async function readFrameworkFiles(cwd, pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const tsconfig = parseLoose((await read(cwd, 'tsconfig.json')) ?? '') ?? {};
  const included = [...(tsconfig.include ?? []), ...(tsconfig.files ?? [])].map(String);
  const out = [];
  for (const framework of FRAMEWORK_FILES.filter((entry) => deps[entry.dep])) {
    // The trailing slash stays: `.expo/` in .gitignore matches only a directory, and git
    // cannot tell that a path which does not exist yet would be one.
    const res = await run('git', ['check-ignore', '--no-index', '--', ...framework.paths], { cwd });
    const ignored = res.stdout.split('\n').map((line) => line.trim().replace(/\/$/, '')).filter(Boolean);
    const paths = framework.paths.filter((p) => ignored.includes(p.replace(/\/$/, '')));
    if (paths.length === 0) continue;
    const named = paths.filter((p) => included.some((entry) => entry === p || entry.startsWith(p) || entry.startsWith(`${p.replace(/\/$/, '')}/`)));
    const required = paths.filter((p) => (tsconfig.files ?? []).includes(p));
    out.push({ by: framework.by, paths, typecheck: required.length > 0 ? 'required' : named.length > 0 ? 'optional' : 'unused', named });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge request checklists and CONTRIBUTING merge rules
// ---------------------------------------------------------------------------

const TEMPLATE = /^(?:\.gitlab\/merge_request_templates\/[^/]+\.md|(?:\.github\/|docs\/)?pull_request_template\.md|\.github\/PULL_REQUEST_TEMPLATE(?:\.md|\/[^/]+\.md))$/i;

/** `[{ file, items: [{ line, text }] }]`: the checkbox items of every merge or pull request template. */
export async function readChecklists(cwd, files) {
  const out = [];
  for (const file of files.filter((name) => TEMPLATE.test(name)).sort().slice(0, 3)) {
    const lines = ((await read(cwd, file)) ?? '').split('\n');
    const items = [];
    lines.forEach((raw, index) => {
      if (!/^\s*[-*]\s+\[[ xX]\]\s+\S/.test(raw)) return;
      const text = quotable(raw);
      if (text.length >= 4) items.push({ line: index + 1, text });
    });
    if (items.length > 0) out.push({ file, items: items.slice(0, 15), more: Math.max(0, items.length - 15) });
  }
  return out;
}

const CONTRIBUTING = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', '.gitlab/CONTRIBUTING.md'];

/** The kinds of merge rule a contributing guide states, each as a test on one line. */
const MERGE_RULES = [
  ['merge mode', /\b(?:squash(?:ed|es)?|fast[- ]forward|rebase(?:d)? (?:and|before) merg|merge commits?|semi-linear)\b/i],
  ['exception', /\brevert\b.*\b(?:accept|allow|exempt|except|fine|kept|as[- ]is)|\b(?:accept|allow|exempt|except)\w*\b.*\brevert/i],
  ['approval', /\bself[- ]approv|\bapprove (?:their|your|his|her) own\b|\bcode ?owners? (?:may|can) (?:merge|approve)/i],
];

/** `[{ file, line, kind, text }]`: the merge mode, approval rules and commit-rule exceptions CONTRIBUTING states. */
export async function readMergeRules(cwd, files) {
  const file = CONTRIBUTING.find((name) => files.includes(name));
  if (!file) return [];
  const out = [];
  let fenced = false;
  ((await read(cwd, file)) ?? '').split('\n').forEach((raw, index) => {
    if (/^\s*```/.test(raw)) fenced = !fenced;
    if (fenced || /^\s*#/.test(raw) || /^\s*\|/.test(raw)) return;
    const kind = MERGE_RULES.find(([, pattern]) => pattern.test(raw))?.[0];
    const text = quotable(raw);
    if (kind && text.length >= 12 && text.length <= 300) out.push({ file, line: index + 1, kind, text });
  });
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Decisions written down outside a table
// ---------------------------------------------------------------------------

/** Files where a team writes "decided" in passing: config, contributing guides, owners, docs. */
const NOTE_FILES = /^(?:CONTRIBUTING\.md|(?:\.github|\.gitlab|docs)\/CONTRIBUTING\.md|(?:\.github\/|\.gitlab\/|docs\/)?CODEOWNERS|[\w.-]*\.config\.[cm]?[jt]s|app\.json|eas\.json|docs?\/.+\.mdx?|README\.md)$/;

/** "decided 2026-03-02", "Decided: …", "Decision (2026-03-02): …". */
const DECIDED = /\bdecided\b[^\n]{0,40}?\b\d{4}-\d{2}-\d{2}\b|\b\d{4}-\d{2}-\d{2}\b[^\n]{0,20}?\bdecided\b|\b(?:decided|decision)\s*(?:\([^)]*\))?\s*:/i;

/**
 * `[{ file, line, text }]`: lines that say something was decided, outside a Markdown table.
 *
 * The Status-column rows are read by `review` already; these are the rest, which in the
 * field outnumbered the table rows six to one: a dated comment above a setting in
 * app.config.ts, a line in CONTRIBUTING, a note in CODEOWNERS. A decision records folder is
 * left out; its records are the decisions, not mentions of them.
 */
export async function readDecidedNotes(cwd, files) {
  const out = [];
  for (const file of files.filter((name) => NOTE_FILES.test(name) && !/(?:^|\/)(?:decisions?|adrs?)\//i.test(name))) {
    const lines = ((await read(cwd, file)) ?? '').split('\n');
    lines.forEach((raw, index) => {
      if (/^\s*\|/.test(raw) || !DECIDED.test(raw)) return;
      const text = quotable(raw.replace(/^\s*(?:\/\/+|#+|\/?\*+|<!--)\s*/, '').replace(/\s*(?:\*\/|-->)\s*$/, ''));
      if (text.length >= 8) out.push({ file, line: index + 1, text: text.length > 200 ? `${text.slice(0, text.lastIndexOf(' ', 200))} …` : text });
    });
  }
  return out;
}

/** Everything above, read once for the scan. */
export async function readToolchain(cwd, files, pkg) {
  return {
    prettier: await readPrettier(cwd, files, pkg),
    jest: await readJest(cwd, files, pkg),
    expo: await readExpo(cwd, files, pkg),
    metro: await readMetro(cwd, files),
    frameworkFiles: await readFrameworkFiles(cwd, pkg),
    checklists: await readChecklists(cwd, files),
    mergeRules: await readMergeRules(cwd, files),
  };
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const optionText = ([name, value]) => `${name} ${typeof value === 'string' ? JSON.stringify(value) : value}`;

/** The Format line: the config and the options in it, the rest left to Prettier's defaults. */
export function prettierLine(prettier, codeIfSafe) {
  const where = prettier.source.startsWith('package.json') ? `${codeIfSafe('package.json')} "prettier"` : codeIfSafe(prettier.source);
  const options = prettier.options.length > 0 ? `: ${prettier.options.map(optionText).join(', ')}; every other option is Prettier's default` : '';
  return `Format: Prettier configured by ${where}${options}.`;
}

/** The Jest line: preset, module mocks and setup files. */
export function jestLine(jest, codeIfSafe) {
  const where = jest.source.startsWith('package.json') ? `${codeIfSafe('package.json')} "jest"` : codeIfSafe(jest.source);
  const parts = [];
  if (jest.preset) parts.push(`preset ${codeIfSafe(jest.preset)}`);
  if (jest.mappers.length > 0) {
    parts.push(`moduleNameMapper mocks ${jest.mappers.slice(0, 6).map(([from, to]) => `${codeIfSafe(from)} → ${codeIfSafe(to)}`).join(', ')}${jest.mappers.length > 6 ? `, and ${jest.mappers.length - 6} more` : ''}`);
  }
  if (jest.setup.length > 0) parts.push(`setup in ${jest.setup.slice(0, 3).map(codeIfSafe).join(', ')}`);
  const mocks = jest.mappers.length > 0 ? ' In tests, an import the mocks match gets the mock, not the file.' : '';
  return `Jest (${where}): ${parts.join('; ')}.${mocks}`;
}

/** Stack rules the Expo and Metro configs make true here. */
export function frameworkRules(toolchain, codeIfSafe) {
  const rules = [];
  const { expo, metro } = toolchain;
  if (expo?.runtime?.policy) {
    const what = RUNTIME_POLICY[expo.runtime.policy];
    rules.push(`runtimeVersion uses the ${expo.runtime.policy} policy (${codeIfSafe(expo.source)})${what ? `: ${what}` : ''}.`);
  } else if (expo?.runtime?.fixed) {
    rules.push(`runtimeVersion is fixed at ${expo.runtime.fixed} in ${codeIfSafe(expo.source)}: change it by hand whenever native code changes, or an update reaches builds that cannot run it.`);
  }
  if (expo?.experiments.length > 0) {
    rules.push(
      `Expo experiments on in ${codeIfSafe(expo.source)}: ${expo.experiments.map((name) => (EXPERIMENTS[name] ? `${name} (${EXPERIMENTS[name]})` : name)).join('; ')}.`,
    );
  }
  if (metro) {
    rules.push(
      metro.svg
        ? `${codeIfSafe(metro.source)} transforms .svg files with ${metro.transformer}: an .svg import is a React component, not an image source.`
        : `${codeIfSafe(metro.source)} replaces Metro's Babel transformer with ${metro.transformer}.`,
    );
  }
  return rules;
}

/** The Boundaries line for files a framework writes and git ignores. */
export function frameworkFilesLine(entries, codeIfSafe) {
  return entries
    .map((entry) => {
      const typecheck = {
        required: `tsconfig.json lists ${entry.paths.filter((p) => entry.named.includes(p)).join(', ')} in "files", so type-checking needs them: run Expo or the framework once first.`,
        optional: `tsconfig.json includes ${entry.named.join(', ')} as a pattern, so type-checking runs without them on a fresh clone and reads them once they exist.`,
        unused: 'Type-checking does not read them.',
      }[entry.typecheck];
      // Backticked whether or not they exist yet: the checker counts a git-ignored path as
      // generated, not missing, and these were confirmed ignored.
      const one = entry.paths.length === 1;
      return `**Generated by the framework.** ${entry.paths.map((p) => `\`${p}\``).join(' and ')} ${one ? 'is' : 'are'} written by ${entry.by} and git-ignored: never edit or commit ${one ? 'it' : 'them'}. ${typecheck}`;
    })
    .join('\n');
}
