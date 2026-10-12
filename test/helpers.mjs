// Shared fixtures for NASO's test suite: temporary repositories, the bin and flow drivers,
// and the seeded project shapes. Zero dependencies: node:test plus Node core modules.

import test from 'node:test';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathExists } from '../tooling/lib.mjs';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_DIR = path.join(PACKAGE_ROOT, 'tooling');
export const BIN = path.join(PACKAGE_ROOT, 'bin', 'naso-dev.mjs');
export const AGENTS = 'AGENTS.md';

/**
 * Drive the flow with a scripted question layer and record every question it asks.
 *
 * Written as `node -e` so the child has no dependency resolution of its own and
 * inherits nothing from the test process except the repository directory. Each
 * question is logged as a `@@{json}` line at the moment it is asked, so a test can
 * check what was on screen before it and what was on disk when it was answered.
 */
export const RUN_FLOW_SCRIPTED = `
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  const { main } = await import(${JSON.stringify(path.join(TOOL_DIR, 'flow.mjs'))});
  const dir = process.argv[1];
  const script = JSON.parse(process.env.NASO_SCRIPT);
  const decisions = [...(script.decisions ?? [])];
  const log = (event) => process.stdout.write('@@' + JSON.stringify(event) + '\\n');
  const onDisk = () => ({
    agents: existsSync(path.join(dir, 'AGENTS.md')),
    naso: existsSync(path.join(dir, '.naso')),
  });
  main([dir, ...(script.args ?? [])], {
    interactive: true,
    prompts: {
      questions: async (style, options, context) => {
        log({ ask: 'questions', hook: context.hook.state, trackedDir: context.hook.trackedDir, hasBlock: context.hasBlock });
        return script.questions === null
          ? null
          : { track: options.track, noHook: options.noHook, force: options.force, hookAction: options.hookAction, ...script.questions };
      },
      decide: async (style, info) => {
        const answer = decisions.length > 0 ? decisions.shift() : null;
        log({ ask: 'decide', ...info, answer, ...onDisk() });
        return answer;
      },
      pickArea: async (style, areas) => {
        log({ ask: 'pickArea', areas: areas.map((area) => area.name) });
        return script.area ?? null;
      },
      afterRejections: async () => {
        log({ ask: 'afterRejections', ...onDisk() });
        return script.finish ?? null;
      },
      done: (message) => log({ done: message }),
    },
  }).then(() => process.exit(process.exitCode ?? 0), (err) => {
    console.error(err);
    process.exit(1);
  });
`;

/** Run the scripted flow; returns the process result plus the questions it asked. */
export async function driveFlow(dir, script = {}) {
  const res = await exec(process.execPath, ['--input-type=module', '-e', RUN_FLOW_SCRIPTED, dir], dir, {
    NASO_SCRIPT: JSON.stringify(script),
  });
  const events = res.stdout
    .split('\n')
    .filter((line) => line.startsWith('@@'))
    .map((line) => JSON.parse(line.slice(2)));
  return { ...res, events };
}

// Secret-shaped fixtures are assembled at runtime and never written whole. A literal
// here is a literal in the repository, and a push to a host with secret scanning on
// would block NASO's own tests as though they had leaked a real credential.
export const STRIPE_FIXTURE = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123'].join('_');
export const GITHUB_FIXTURE = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_');

export function exec(cmd, args, cwd, env = {}) {
  return new Promise((resolve) => {
    // npm exports FORCE_COLOR to the scripts it runs. Children get it only when a test
    // asks for it, so `npm test` and `node --test` see the same output.
    const { FORCE_COLOR, ...inherited } = process.env;
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...inherited, ...env } });
    let stdout = '';
    let stderr = '';
    // A child blocked on a prompt nobody can answer is a failure, not a hung suite.
    const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.env.NASO_TEST_EXEC_TIMEOUT ?? 60_000));
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run a tool the way a user would: through the bin entry point. */
export function naso(args, cwd) {
  return exec(process.execPath, [BIN, ...args], cwd);
}

export async function filesIn(dir, suffixes) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && suffixes.some((s) => entry.name.endsWith(s))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

export async function withRepo(fn, { seed = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naso-test-'));
  const git = (...args) => exec('git', args, dir);
  const script = (name, args = []) => naso([name, dir, ...args], dir);
  const bare = (args = []) => naso([dir, ...args], dir);
  const raw = (name, args = []) =>
    exec(process.execPath, [path.join(TOOL_DIR, name), dir, ...args], dir);
  const type = (keys) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, dir, ...(keys ?? [])], {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.on('error', reject);
      setTimeout(() => child.stdin.end(), 50);
      for (const key of keys ?? []) setTimeout(() => child.stdin.write(key), 120);
    });

  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'NASO Test');
    if (seed) {
      await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
      await git('add', 'seed.txt');
      await git('commit', '-qm', 'init');
    }
    return await fn({ dir, git, script, bare, raw, type });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function put(dir, relPath, contents = '') {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

/** A digest of every byte under `dir`, .git included, keyed by path. */
export async function treeHash(dir) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const walk = async (rel) => {
    const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        hash.update(`${child}\0`);
        hash.update(await readFile(path.join(dir, child)));
      }
    }
  };
  await walk('');
  return hash.digest('hex');
}

export const plainStyleForTest = new Proxy({}, { get: () => (text) => String(text) });
export const read = (dir, relPath) => readFile(path.join(dir, relPath), 'utf8');
export const exists = (dir, relPath) => pathExists(path.join(dir, relPath));

/** A repository with one real area, a package manifest and a git history. */
export async function seedProject(dir, git) {
  await put(dir, 'src/index.ts', 'export const x = 1;\n');
  await put(dir, 'src/thing.ts', 'export const y = 2;\n');
  await put(dir, 'README.md', '# Demo\n');
  await put(dir, 'package.json', JSON.stringify({ name: 'demo', scripts: { lint: 'echo lint' } }));
  await git('add', '-A');
  await git('commit', '-qm', 'project');
}

/**
 * A repository shaped like the one the generator was last verified against: Expo/RN,
 * pnpm, node:test, a CI workflow whose verify job delegates to a script, four boundary
 * verifiers, an alias declared in babel but not in tsconfig, a test directory the test
 * script never runs, and ignored native build output.
 *
 * Every one of those is a place the generator used to say something false.
 */
export async function seedEgom(dir, git) {
  await put(
    dir,
    'package.json',
    JSON.stringify({
      name: 'egom',
      private: true,
      packageManager: 'pnpm@9.1.0',
      scripts: {
        verify: 'node scripts/verify.mjs',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'node --test test/',
        'verify:boundary:auth': 'node scripts/verify-boundary-auth.mjs',
        'verify:boundary:payments': 'node scripts/verify-boundary-payments.mjs',
        'verify:boundary:db': 'node scripts/verify-boundary-db.mjs',
        'verify:boundary:api': 'node scripts/verify-boundary-api.mjs',
        'check:deps': 'node scripts/check-deps.mjs',
        'check:secrets': 'node scripts/check-secrets.mjs',
      },
      dependencies: { expo: '~51.0.0', react: '18.2.0' },
      devDependencies: { typescript: '5.3.3', eslint: '8.56.0' },
    }),
  );

  await put(
    dir,
    '.github/workflows/ci.yml',
    [
      'name: CI',
      'on: [push, pull_request]',
      'jobs:',
      '  verify:',
      '    name: verify',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: pnpm/action-setup@v4',
      '        with:',
      '          version: 9',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 20',
      '          cache: pnpm',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm run verify',
      '',
    ].join('\n'),
  );

  await put(
    dir,
    'scripts/verify.mjs',
    [
      "const steps = ['typecheck', 'lint', 'test'];",
      'for (const step of steps) {',
      "  await run('pnpm', ['run', step]);",
      '}',
      "await run('pnpm', ['exec', 'expo', 'check']);",
      "await run('pnpm', ['run', 'check:deps']);",
      "await run('pnpm', ['run', 'verify:boundary:auth']);",
      "await run('pnpm', ['run', 'verify:boundary:payments']);",
      "await run('pnpm', ['run', 'verify:boundary:db']);",
      "await run('pnpm', ['run', 'verify:boundary:api']);",
      "await run('pnpm', ['run', 'check:secrets']);",
      '',
    ].join('\n'),
  );

  await put(dir, 'app/_layout.tsx', 'export default function Layout() { return null; }\n');
  await put(dir, 'app/index.tsx', 'export default function Home() { return null; }\n');
  await put(dir, 'src/lib/money.ts', 'export const money = 1;\n');
  await put(dir, 'test/money.test.ts', "it('adds', () => {});\n");
  // A test directory the test script never names: node --test test/ will not run these.
  await put(dir, 'e2e/checkout.spec.ts', "describe('checkout', () => {});\n");

  // Boundary verifiers that exist, and the doc each one points at. The rule lives in the
  // doc; the script is the thing that fails a commit.
  const boundaries = [
    ['auth', 'auth'],
    ['payments', 'payments'],
    ['db', 'db'],
    ['api', 'api'],
  ];
  for (const [name, doc] of boundaries) {
    await put(
      dir,
      `scripts/verify-boundary-${name}.mjs`,
      `// The rule: see docs/boundaries/${doc}.md\nimport { fail } from '../lib/fail.mjs';\nexport const check = () => fail('${name}');\n`,
    );
    await put(
      dir,
      `docs/boundaries/${doc}.md`,
      `# ${doc}\n\nWhat may import what across this seam, and why.\n`,
    );
  }
  await put(dir, 'README.md', '# Egom\n\nRequires Node.js >= 18 to run.\n');
  await put(dir, '.nvmrc', '20.11.0\n');
  await put(dir, '.gitignore', 'node_modules/\nios/build/\n.expo/\n*.keystore\n.env\n');
  await git('add', '-A');
  await git('commit', '-qm', 'egom');

  // Ignored native build output, exactly as `expo prebuild` leaves it.
  for (let i = 0; i < 12; i++) await put(dir, `ios/build/Gen${i}.m`, '// generated\n');
}

/** Every file under `root`, except git's object store (compressed history, not ours). */
export async function allFiles(root, rel = '') {
  const out = [];
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (child === path.join('.git', 'objects')) continue;
    if (entry.isDirectory()) out.push(...(await allFiles(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

export const FOREIGN_HOOK = '#!/bin/sh\necho ran > "$(git rev-parse --show-toplevel)/.foreign-hook-ran"\nexit 0\n';

/** `path  new, 12 lines` rows from the plan's file table. */
export function plannedWrites(stdout) {
  const rows = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^ {2}(\S+)\s+(?:(new|replace|replace block|moved here), |(append) )(\d+) lines?\b/);
    if (m) rows.set(m[1], { change: m[2] ?? m[3], lines: Number(m[4]) });
  }
  return rows;
}

export const linesIn = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/** The audit's ground-truth fixture: pnpm, a spawnSync gate, two aliases files, a keystore. */
export async function seedGroundTruth(dir, git) {
  await put(
    dir,
    'package.json',
    JSON.stringify({
      name: 'fixture',
      version: '0.0.1',
      type: 'module',
      main: 'src/index.js',
      packageManager: 'pnpm@9.12.0',
      engines: { node: '>=20' },
      scripts: {
        verify: 'node scripts/verify.mjs',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'node --test test/',
        'verify:boundaries': 'node scripts/check-boundaries.mjs',
        'verify:licenses': 'node scripts/check-licenses.mjs',
      },
      devDependencies: { typescript: '^5.4.0' },
    }),
  );
  await put(
    dir,
    'scripts/verify.mjs',
    [
      "import { spawnSync } from 'node:child_process';",
      "const steps = ['typecheck', 'lint', 'test', 'verify:boundaries', 'verify:licenses'];",
      'for (const step of steps) {',
      "  const r = spawnSync('pnpm', ['run', step], { stdio: 'inherit' });",
      '  if (r.status !== 0) process.exit(r.status ?? 1);',
      '}',
      '',
    ].join('\n'),
  );
  await put(dir, 'scripts/check-boundaries.mjs', '// see docs/boundaries.md\n');
  await put(dir, 'scripts/check-licenses.mjs', '// licenses\n');
  await put(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, baseUrl: '.', paths: { '@a/*': ['src/a/*'] } } }));
  await put(dir, 'babel.config.js', "module.exports = { plugins: [['module-resolver', { alias: { '@a': './src/a', '@b': './src/b' } }]] };\n");
  await put(dir, 'src/index.js', 'export const x = 1;\n');
  await put(dir, 'test/a.test.mjs', "import test from 'node:test'; test('x', () => {});\n");
  await put(dir, 'src/outside.test.mjs', "import test from 'node:test'; test('y', () => {});\n");
  await put(dir, 'README.md', '# Fixture\n\nRequires Node 18.\n');
  await put(dir, '.gitignore', 'node_modules/\nbuild/\n*.keystore\n.env*\n*.pem\n');
  await put(dir, 'test.keystore', 'NOT_A_REAL_KEYSTORE_SENTINEL\n');
  await put(dir, 'build/App.swift', 'class App {}\n');
  await git('add', '-A');
  await git('add', '-f', 'test.keystore');
  await git('commit', '-qm', 'fixture');
}

export const sectionOf = (text, heading) => {
  const start = text.indexOf(`## ${heading}`);
  const end = text.indexOf('\n## ', start + 3);
  return text.slice(start, end === -1 ? undefined : end);
};

/** Answer the real questions through streams: one key sequence per prompt. */
export async function answerRealQuestions(context, keys) {
  const { PassThrough } = await import('node:stream');
  const { terminalPrompts } = await import(pathToFileURL(path.join(TOOL_DIR, 'flow.mjs')).href);
  const input = new PassThrough();
  const output = new PassThrough();
  let frames = '';
  output.on('data', (chunk) => (frames += chunk));
  const options = { track: false, noHook: false, force: false, hookAction: null };
  const answer = terminalPrompts({ input, output }).questions(plainStyleForTest, options, context);
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    input.write(key);
  }
  return { answer: await answer, frames: frames.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '') };
}
