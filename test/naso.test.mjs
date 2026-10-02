#!/usr/bin/env node
// NASO's own test suite. Zero dependencies: node:test plus Node core modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coversUnit,
  countTodoMarkers,
  parseArgs,
  toolVersion,
  pathExists,
  compareVersions,
  splitNul,
  parseGitStatusPorcelainZ,
  unquoteGitPath,
  parseAddedLines,
  scanAddedLines,
} from '../tooling/lib.mjs';
import {
  extractPathTokens,
  topLevelEntries,
  areasOf,
  createBriefing,
  refreshBriefingStamp,
  readBriefingMarkerValue,
  NASO_START,
  NASO_END,
  listRepoFiles,
} from '../tooling/briefing.mjs';
import { notableAdditions, inScope, resolveScope } from '../tooling/validate.mjs';
import { buildHookScript, isNasoHook } from '../tooling/install.mjs';
import { normalizeExclusions, vendorTooling, isVendored, vendoredVersion } from '../tooling/vendor.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_DIR = path.join(PACKAGE_ROOT, 'tooling');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'naso-dev.mjs');
const AGENTS = 'AGENTS.md';

// Secret-shaped fixtures are assembled at runtime and never written whole. A literal
// here is a literal in the repository, and a push to a host with secret scanning on
// would block NASO's own tests as though they had leaked a real credential.
const STRIPE_FIXTURE = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123'].join('_');
const GITHUB_FIXTURE = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_');

function exec(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Run a tool the way a user would: through the bin entry point. */
function naso(args, cwd) {
  return exec(process.execPath, [BIN, ...args], cwd);
}

async function filesIn(dir, suffixes) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && suffixes.some((s) => entry.name.endsWith(s))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

async function withRepo(fn, { seed = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naso-test-'));
  const git = (...args) => exec('git', args, dir);
  const script = (name, args = []) => naso([name, dir, ...args], dir);
  const raw = (name, args = []) =>
    exec(process.execPath, [path.join(TOOL_DIR, name), dir, ...args], dir);

  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'NASO Test');
    if (seed) {
      await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
      await git('add', 'seed.txt');
      await git('commit', '-qm', 'init');
    }
    return await fn({ dir, git, script, raw });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(dir, relPath, contents = '') {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

const read = (dir, relPath) => readFile(path.join(dir, relPath), 'utf8');
const exists = (dir, relPath) => pathExists(path.join(dir, relPath));

/** A repository with one real area, a package manifest and a git history. */
async function seedProject(dir, git) {
  await put(dir, 'src/index.ts', 'export const x = 1;\n');
  await put(dir, 'src/thing.ts', 'export const y = 2;\n');
  await put(dir, 'README.md', '# Demo\n');
  await put(dir, 'package.json', JSON.stringify({ name: 'demo', scripts: { lint: 'echo lint' } }));
  await git('add', '-A');
  await git('commit', '-qm', 'project');
}

// ---------------------------------------------------------------------------
// lib
// ---------------------------------------------------------------------------

test('coversUnit matches tokens with escaping', () => {
  const text = 'See `docs/README.md`. Also check `foo/bar-baz.txt`.';
  assert.ok(coversUnit(text, 'docs/README.md'));
  assert.ok(coversUnit(text, 'foo/bar-baz.txt'));
  assert.ok(!coversUnit(text, 'missing/file.txt'));
});

test('countTodoMarkers counts TODO(fill) and TODO(describe)', () => {
  assert.equal(countTodoMarkers('TODO(fill) and TODO(describe) TODO(other)'), 2);
});

test('parseArgs handles flags, --key=value and --key value', () => {
  const { flags, positional, values } = parseArgs(['dir', '--track', '--scope=src,docs']);
  assert.ok(flags.has('track'));
  assert.equal(positional[0], 'dir');
  assert.equal(values.get('scope'), 'src,docs');
});

test('splitNul keeps non-ASCII fields and drops the empty tail', () => {
  assert.deepEqual(splitNul('é.env\0src/\0'), ['é.env', 'src/']);
  assert.deepEqual(splitNul(''), []);
  assert.deepEqual(splitNul('\0\0'), []);
});

test('parseGitStatusPorcelainZ consumes the rename origin field and keeps alignment', () => {
  const raw = 'R  new/thing.ts\0old/thing.ts\0?? added.ts\0 M changed.ts\0';
  const entries = parseGitStatusPorcelainZ(raw);
  assert.deepEqual(entries, [
    { status: 'R', path: 'new/thing.ts', from: 'old/thing.ts' },
    { status: '??', path: 'added.ts', from: null },
    { status: 'M', path: 'changed.ts', from: null },
  ]);
});

test('parseGitStatusPorcelainZ does not quote a non-ASCII path into octal', () => {
  const entries = parseGitStatusPorcelainZ('?? café/menü.ts\0');
  assert.equal(entries[0].path, 'café/menü.ts');
});

test('unquoteGitPath decodes octal escapes and quotes', () => {
  assert.equal(unquoteGitPath('"caf\\303\\251.env"'), 'café.env');
  assert.equal(unquoteGitPath('"he\\"llo.ts"'), 'he"llo.ts');
  assert.equal(unquoteGitPath('"back\\\\slash.ts"'), 'back\\slash.ts');
  assert.equal(unquoteGitPath('plain.ts'), 'plain.ts');
});

test('parseAddedLines keeps a quoted path findable, and reports no matched text', () => {
  const diff = [
    'diff --git a/x b/x',
    '+++ "b/caf\\303\\251.env"',
    '@@ -0,0 +1 @@',
    '+API_KEY=' + STRIPE_FIXTURE,
  ].join('\n');
  const files = parseAddedLines(diff);
  assert.deepEqual([...files.keys()], ['café.env']);
  const hits = scanAddedLines(files);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'café.env');
  assert.equal(hits[0].line, 1);
  assert.ok(!JSON.stringify(hits).includes(STRIPE_FIXTURE), 'the matched value leaked into the report');
});

test('compareVersions orders by segment, not by string length', () => {
  assert.ok(compareVersions('1.0.9', '1.0.10') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

// ---------------------------------------------------------------------------
// areas
// ---------------------------------------------------------------------------

test('only directories are areas; root files are an inventory, not an area', () => {
  const entries = topLevelEntries([
    'src/index.ts',
    'package.json',
    'README.md',
    'LICENSE',
    '.gitignore',
    'docs/guide.md',
    'node_modules/x/index.js',
    '.git/config',
  ]);
  const areas = areasOf(entries).map((e) => e.name);
  assert.deepEqual(areas, ['docs', 'src']);
  assert.ok(!areas.includes('package.json'));
  assert.ok(areas.includes('src'));
});

test('notableAdditions proposes directories only, never a root file', () => {
  const units = notableAdditions([
    'newarea/first.ts',
    'newarea/second.ts',
    'vitest.config.ts',
    'package.json',
    '.naso/tooling/validate.mjs',
    'AGENTS.md',
    'node_modules/x.js',
    'dist/out.js',
  ]);
  assert.deepEqual(units, ['newarea/']);
});

test('inScope and resolveScope agree on prefix boundaries', () => {
  assert.equal(resolveScope('src, docs/', null).join('|'), 'src|docs');
  assert.equal(resolveScope(null, null), null);
  assert.ok(inScope('src/a.ts', ['src']));
  assert.ok(!inScope('srcery/a.ts', ['src']));
  assert.ok(inScope('docs/a.md', ['docs/']));
});

// ---------------------------------------------------------------------------
// package identity
// ---------------------------------------------------------------------------

test('VERSION and package.json declare the same version', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const versionFile = (await readFile(path.join(PACKAGE_ROOT, 'VERSION'), 'utf8')).trim();
  assert.equal(versionFile, pkg.version);
  assert.equal(await toolVersion(), pkg.version);
});

test('the package is named naso-dev and the bin matches it', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'naso-dev');
  assert.equal(pkg.bin['naso-dev'], './bin/naso-dev.mjs');
  assert.ok(await pathExists(BIN));
});

test('package metadata points at the repository and gates a publish on the tests', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.repository.url, /github\.com\/MrVal042\/\.naso/);
  assert.match(pkg.bugs.url, /github\.com\/MrVal042\/\.naso\/issues/);
  assert.ok(pkg.homepage.startsWith('https://github.com/MrVal042/.naso'));
  assert.equal(pkg.scripts.prepublishOnly, 'node --test');
  assert.equal(pkg.scripts.test, 'node --test');
  for (const wanted of ['bin', 'tooling', 'VERSION', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(wanted), `files is missing ${wanted}`);
  }
  assert.equal(pkg.license, 'MIT');
});

test('the LICENSE file exists, is MIT, and names the holder', async () => {
  const text = await readFile(path.join(PACKAGE_ROOT, 'LICENSE'), 'utf8');
  assert.match(text, /MIT License/);
  assert.match(text, /Copyright \(c\) MrVal/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('no printed text suggests `npx naso` or hardcodes a home directory', async () => {
  const sources = [
    ...(await filesIn(TOOL_DIR, ['.mjs', '.md'])),
    BIN,
    path.join(PACKAGE_ROOT, 'README.md'),
  ];
  const homePattern = /\/(?:home|Users)\/[A-Za-z0-9._-]+\//;

  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes('npx naso '), `${file} still suggests \`npx naso\``);
    const offending = text
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => homePattern.test(line) && !line.trimStart().startsWith('//'));
    assert.deepEqual(offending, [], `${file} hardcodes an absolute home path`);
  }
});

// ---------------------------------------------------------------------------
// the NASO block in AGENTS.md
// ---------------------------------------------------------------------------

test('extractPathTokens pulls backtick-quoted paths', () => {
  const tokens = extractPathTokens('- `src/foo.ts` — does a thing\n`docs/guide.md`');
  assert.deepEqual(new Set(tokens), new Set(['src/foo.ts', 'docs/guide.md']));
});

test('createBriefing on a repository with no AGENTS.md writes the markers', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const result = await createBriefing(dir);
    assert.ok(result.ok);
    const text = await read(dir, AGENTS);
    assert.ok(text.includes(NASO_START));
    assert.ok(text.includes(NASO_END));
    assert.equal(readBriefingMarkerValue(text, 'version'), await toolVersion());
  });
});

test('createBriefing appends below a hand-written AGENTS.md and changes none of it', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const mine = '# My rules\n\nLine one, mine.\nLine two, also mine.\n';
    await writeFile(path.join(dir, AGENTS), mine, 'utf8');

    const result = await createBriefing(dir);
    assert.ok(result.ok);
    assert.ok(result.appended);

    const text = await read(dir, AGENTS);
    assert.ok(text.startsWith(mine), 'the hand-written part must be byte-identical at the top');
    assert.ok(text.includes(NASO_START));
    assert.ok(text.includes('Line one, mine.'));
  });
});

test('createBriefing without --force leaves an existing NASO block exactly as it is', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await createBriefing(dir);
    const before = await read(dir, AGENTS);

    const result = await createBriefing(dir);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'has-block');
    assert.equal(await read(dir, AGENTS), before, 'the file changed without --force');
  });
});

test('createBriefing --force replaces only what is between the markers', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const head = '# My rules\n\nAbove the block, hand written.\n\n';
    const tail = '\nBelow the block, also hand written.\n';
    await writeFile(
      path.join(dir, AGENTS),
      `${head}${NASO_START}\nstale generated content\n${NASO_END}${tail}`,
      'utf8',
    );

    const result = await createBriefing(dir, { force: true });
    assert.ok(result.ok);
    assert.ok(result.replacedBlock);

    const text = await read(dir, AGENTS);
    assert.ok(text.startsWith(head), 'prose above the block must survive --force');
    assert.ok(text.endsWith(tail), 'prose below the block must survive --force');
    assert.ok(!text.includes('stale generated content'), 'the old block should be gone');
    assert.ok(text.includes('Project Structure'));
  });
});

test('refreshBriefingStamp moves the stamp forward and never down', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await createBriefing(dir);

    const up = await refreshBriefingStamp(dir, { current: '99.0.0' });
    assert.equal(up.changed, true);
    assert.equal(readBriefingMarkerValue(await read(dir, AGENTS), 'version'), '99.0.0');

    const down = await refreshBriefingStamp(dir, { current: '1.0.0' });
    assert.equal(down.changed, false, 'a newer stamp must not be downgraded');
    assert.equal(readBriefingMarkerValue(await read(dir, AGENTS), 'version'), '99.0.0');
  });
});

test('refreshBriefingStamp rewrites only the stamp line', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await createBriefing(dir);
    await writeFile(
      path.join(dir, AGENTS),
      (await read(dir, AGENTS)).replace('Project Structure', 'My hand-edited heading'),
      'utf8',
    );
    const before = (await read(dir, AGENTS))
      .split('\n')
      .filter((l) => !l.startsWith('<!-- version:'));

    await refreshBriefingStamp(dir, { current: '42.0.0' });

    const after = (await read(dir, AGENTS))
      .split('\n')
      .filter((l) => !l.startsWith('<!-- version:'));
    assert.deepEqual(after, before, 'refresh touched more than the stamp');
  });
});

// ---------------------------------------------------------------------------
// vendoring
// ---------------------------------------------------------------------------

test('normalizeExclusions makes vendor, ./vendor and vendor/// one prefix', () => {
  assert.deepEqual(normalizeExclusions(['./vendor/', 'vendor', 'docs///', '']), ['docs', 'vendor']);
  assert.deepEqual(normalizeExclusions('not-an-array'), []);
});

test('vendorTooling copies the scripts, the README and the VERSION', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.equal(await isVendored(dir), false);

    const copied = await vendorTooling(dir);
    assert.ok(copied.includes('validate.mjs'));
    assert.ok(copied.includes('README.md'));
    assert.ok(copied.includes('VERSION'));

    assert.equal(await isVendored(dir), true);
    assert.equal(await vendoredVersion(dir), await toolVersion());
    assert.ok(await exists(dir, path.join('.naso', 'tooling', 'lock.mjs')));
  });
});

test('the vendored copy is importable on its own, with no package in sight', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);
    const vendored = path.join(dir, '.naso', 'tooling', 'validate.mjs');
    const res = await exec(process.execPath, [vendored, '--help'], dir);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /naso-dev validate/);
  });
});

// ---------------------------------------------------------------------------
// the hook
// ---------------------------------------------------------------------------

test('buildHookScript resolves the vendored script from the repository root', () => {
  const body = buildHookScript();
  assert.match(body, /git rev-parse --show-toplevel/);
  assert.match(body, /\.naso\/tooling\/validate\.mjs/);
  // The path is assigned inside double quotes, so single quotes around it would end up
  // inside the value and make the -f test fail on every commit.
  assert.match(body, /NASO_SCRIPT="\$REPO_ROOT\/\.naso\/tooling\/validate\.mjs"/);
  assert.ok(!body.includes(`"'.naso`), 'the hook path must not be shell-quoted inside its assignment');
  assert.match(body, /npx naso-dev refresh/, 'a missing script must say how to fix it');
});

test('a hook without the NASO marker is not claimed as ours', () => {
  assert.equal(isNasoHook({ body: '#!/bin/sh\neslint\n' }), false);
  assert.equal(isNasoHook({ body: buildHookScript() }), true);
});

test('a missing vendored script warns once and lets the commit through', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, buildHookScript(), 'utf8');
    await chmod(hook, 0o755);

    await rm(path.join(dir, '.naso'), { recursive: true, force: true });
    await put(dir, 'later.txt', 'ok\n');
    await git('add', 'later.txt');
    const res = await git('commit', '-m', 'after the toolset was deleted');

    const output = res.stdout + res.stderr;
    assert.equal(res.code, 0, `the commit should still succeed: ${output}`);
    assert.match(output, /\.naso\/tooling\/validate\.mjs/);
    assert.match(output, /naso-dev/);
  });
});

test('the gate blocks a staged secret and never prints its value', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, buildHookScript(), 'utf8');
    await chmod(hook, 0o755);

    const secret = STRIPE_FIXTURE;
    await put(dir, 'src/config.ts', `export const key = "${secret}";\n`);
    await git('add', 'src/config.ts');
    const res = await git('commit', '-m', 'oops');

    assert.notEqual(res.code, 0, 'the secret commit should have been refused');
    const output = res.stdout + res.stderr;
    assert.ok(!output.includes(secret), `the secret was printed: ${output}`);
    assert.match(output, /src\/config\.ts/);
    assert.match(output, /src\/config\.ts:1/);
  });
});

test('the gate blocks a secret in a file whose name is not ASCII', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, buildHookScript(), 'utf8');
    await chmod(hook, 0o755);

    const secret = GITHUB_FIXTURE;
    await put(dir, 'café.env', `TOKEN=${secret}\n`);
    await git('add', '-A');
    const res = await git('commit', '-m', 'non-ascii filename');

    const output = res.stdout + res.stderr;
    assert.notEqual(res.code, 0, 'the commit should have been refused');
    assert.ok(!output.includes(secret), 'the secret was printed');
    assert.ok(
      output.includes('café.env'),
      `the report should name the real file, not an octal escape:\n${output}`,
    );
  });
});

test('a staged rename does not derail the gate', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, buildHookScript(), 'utf8');
    await chmod(hook, 0o755);

    await git('mv', 'src/index.ts', 'src/renamed.ts');
    await git('add', '-A');
    const res = await git('commit', '-m', 'rename');

    assert.equal(res.code, 0, `a clean rename should pass:\n${res.stdout}${res.stderr}`);
    const output = res.stdout + res.stderr;
    assert.match(output, /PASS|BLOCKING|passed/i);
  });
});

test('a new area gets one line in the briefing; a new root file does not', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const setup = await script('setup', ['--yes', '--track']);
    assert.equal(setup.code, 0, setup.stdout + setup.stderr);

    // Commit the install first, so the hook has a tracked, clean AGENTS.md to edit.
    await git('add', '-A');
    await git('commit', '-qm', 'naso install');

    await put(dir, 'workers/queue.ts', 'export const q = 1;\n');
    await put(dir, 'vitest.config.ts', 'export default {};\n');
    await git('add', '-A');
    const res = await git('commit', '-m', 'add an area and a root config');

    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    assert.match(text, /workers\//, 'the new area should be noted');
    assert.ok(!/vitest\.config/.test(text), 'a new root file is not an area');
  });
});

test('a commit still runs the gate after the package directory is deleted', async () => {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'naso-pkg-'));
  try {
    await mkdir(path.join(copy, 'tooling'), { recursive: true });
    for (const name of await readdir(TOOL_DIR)) {
      await exec('cp', ['-R', path.join(TOOL_DIR, name), path.join(copy, 'tooling', name)]);
    }
    await mkdir(path.join(copy, 'bin'), { recursive: true });
    await exec('cp', [BIN, path.join(copy, 'bin', 'naso-dev.mjs')]);
    await exec('cp', [path.join(PACKAGE_ROOT, 'VERSION'), path.join(copy, 'VERSION')]);
    await exec('cp', [path.join(PACKAGE_ROOT, 'package.json'), path.join(copy, 'package.json')]);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'naso-repo-'));
    try {
      const git = (...args) => exec('git', args, dir);
      await git('init', '-q', '-b', 'main');
      await git('config', 'user.email', 'test@example.invalid');
      await git('config', 'user.name', 'NASO Test');
      await seedProject(dir, git);

      const pkgBin = path.join(copy, 'bin', 'naso-dev.mjs');
      const setup = await exec(process.execPath, [pkgBin, 'setup', dir, '--yes'], dir);
      assert.equal(setup.code, 0, setup.stdout + setup.stderr);

      // The whole package goes away. The hook must not care.
      await rm(copy, { recursive: true, force: true });

      const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
      assert.ok(await pathExists(hook), 'the hook should live in the repository');

      await put(dir, 'src/after.ts', 'export const z = 3;\n');
      await git('add', 'src/after.ts');
      const res = await git('commit', '-m', 'with no package installed');
      assert.equal(res.code, 0, `the gate should still run: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout + res.stderr, /PASS|passed/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

test('setup --yes writes the briefing, the toolset, the config and the hook', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    assert.ok(await exists(dir, AGENTS));
    assert.ok(await exists(dir, path.join('.naso', 'tooling', 'validate.mjs')));
    assert.ok(await exists(dir, path.join('.naso', 'config.json')));

    const config = JSON.parse(await read(dir, path.join('.naso', 'config.json')));
    assert.equal(config.version, await toolVersion());
    assert.deepEqual(config.exclude, []);

    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    assert.ok(await pathExists(hook));
    const body = await readFile(hook, 'utf8');
    assert.match(body, /\.naso\/tooling\/validate\.mjs/);
  });
});

test('setup excluding an area keeps it out of the briefing and remembers why', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await put(dir, 'vendor/lib.js', 'module.exports = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'vendor');

    const res = await script('setup', ['--yes', '--exclude', 'vendor']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /vendor/);

    const text = await read(dir, AGENTS);
    assert.ok(!/\bvendor\//.test(text), 'the excluded area should not be described');

    const config = JSON.parse(await read(dir, path.join('.naso', 'config.json')));
    assert.deepEqual(config.exclude, ['vendor']);

    // A later run with no --exclude flag must still honour the saved one.
    const again = await script('setup', ['--yes', '--force']);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    const config2 = JSON.parse(await read(dir, path.join('.naso', 'config.json')));
    assert.deepEqual(config2.exclude, ['vendor'], 'a saved exclusion must survive a later run');
    assert.ok(!/\bvendor\//.test(await read(dir, AGENTS)));
  });
});

test('setup rejecting the plan writes nothing at all', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const res = await script('setup', ['--no']);
    assert.equal(await exists(dir, AGENTS), false, 'a rejection must not write AGENTS.md');
    assert.equal(await exists(dir, '.naso'), false, 'a rejection must not vendor the toolset');
    assert.match(res.stdout, /[Nn]othing/);
  });
});

test('setup leaves a hand-written AGENTS.md alone and appends instead', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const mine = '# House rules\n\nDo not touch the generated folder.\n';
    await writeFile(path.join(dir, AGENTS), mine, 'utf8');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.ok(text.startsWith(mine));
    assert.match(res.stdout, /[Aa]ppend/);
  });
});

test('setup does not install over a hook it did not write', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    const theirs = '#!/bin/sh\nnpm run lint\n';
    await writeFile(hook, theirs, 'utf8');
    await chmod(hook, 0o755);

    await script('setup', ['--yes']);
    assert.equal(await readFile(hook, 'utf8'), theirs, 'a foreign hook must be preserved');
  });
});

test('setup in local mode keeps .naso and AGENTS.md out of this machine only', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const excluded = await read(dir, path.join('.git', 'info', 'exclude'));
    assert.match(excluded, /^\.naso$/m);
    assert.match(excluded, /^AGENTS\.md$/m);

    const status = await git('status', '--porcelain');
    assert.ok(!status.stdout.includes('.naso/'), '.naso should be invisible to git');
    assert.ok(!status.stdout.includes('AGENTS.md'), 'AGENTS.md should be invisible to git');
  });
});

// ---------------------------------------------------------------------------
// guide
// ---------------------------------------------------------------------------

test('guide <area> answers for one area and hands over a scope line', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const res = await script('guide', ['src']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /src\//);
    assert.match(res.stdout, /NASO_SCOPE/);
    assert.match(res.stdout, /Tracked and untracked-but-not-ignored files under src\/: [1-9]/);
    assert.match(res.stdout, /What has to pass/);
  });
});

test('guide refuses an area that does not exist and says which ones do', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const res = await script('guide', ['compnents']);
    assert.notEqual(res.code, 0, 'an unknown area should be an error');
    assert.match(res.stdout, /No area or path here matches/);
    assert.match(res.stdout, /src\//, 'it should list the areas that do exist');
  });
});

test('guide --list prints directories and never root files', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const res = await script('guide', ['--list']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /src\//);
    const listed = res.stdout.split('## Next')[0];
    assert.ok(!/^\s*package\.json/m.test(listed), 'package.json is not an area');
  });
});

test('guide --tour still walks the whole briefing', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const res = await script('guide', ['--tour']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /The briefing, in reading order/);
    assert.match(res.stdout, /Next steps/);
  });
});

test('a PowerShell scope line on Windows, a POSIX one everywhere else', async () => {
  const guide = await readFile(path.join(TOOL_DIR, 'guide.mjs'), 'utf8');
  assert.match(guide, /win32/);
  assert.match(guide, /\$env:NASO_SCOPE=/);
});

// ---------------------------------------------------------------------------
// doctor, init, validate
// ---------------------------------------------------------------------------

test('doctor reports the vendored copy and says what to do when it is missing', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);

    const before = await script('doctor');
    assert.match(before.stdout, /vendored toolset/);
    assert.match(before.stdout, /not found/);

    await script('setup', ['--yes']);
    const after = await script('doctor');
    assert.match(after.stdout, /vendored toolset/);
    assert.match(after.stdout, new RegExp(`at ${await toolVersion()}`));
  });
});

test('doctor points at refresh rather than at a reinstall', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);
    const res = await script('doctor');
    assert.match(res.stdout, /npx naso-dev refresh/);
  });
});

test('init explains the vendored copy and writes nothing', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const before = await git('status', '--porcelain');

    const res = await script('init');
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\.naso\/tooling/);
    assert.match(res.stdout, /naso:start/);
    assert.match(res.stdout, /never replaced/i);

    assert.equal((await git('status', '--porcelain')).stdout, before.stdout);
    assert.equal(await exists(dir, AGENTS), false);
  });
});

test('validate blocks an out-of-scope path only when strict scope is on', async () => {
  await withRepo(async ({ dir, git, raw }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/page.md', 'hello\n');
    await git('add', 'docs/page.md');

    const loose = await raw('validate.mjs', ['--staged', '--no-append', '--scope', 'src']);
    assert.equal(loose.code, 0, `a warn-only scope must not block: ${loose.stdout}${loose.stderr}`);
    assert.match(loose.stdout, /out-of-scope/);

    const strict = await raw('validate.mjs', ['--staged', '--no-append', '--scope', 'src', '--strict']);
    assert.notEqual(strict.code, 0, 'strict scope must block');
  });
});

test('validate never lets a task outside its scope touch NASO\'s own copy', async () => {
  await withRepo(async ({ dir, git, raw }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);
    await put(dir, '.naso/tooling/readme-marker.txt', 'touch');
    await git('add', '-A');
    const res = await raw('validate.mjs', ['--staged', '--no-append', '--scope', 'src', '--strict']);
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// end to end on fixtures
// ---------------------------------------------------------------------------

test('a fresh repository passes the gate with no problems to fix', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const setup = await script('setup', ['--yes']);
    assert.equal(setup.code, 0, setup.stdout + setup.stderr);
    assert.match(setup.stdout, /no placeholders left/);
    assert.match(setup.stdout, /Briefing is consistent/);

    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('an Expo-shaped repository produces a usable briefing', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({
        name: 'expo-demo',
        scripts: { lint: 'expo lint', test: 'jest' },
        dependencies: { expo: '~51.0.0', 'expo-router': '~3.0.0', react: '18.2.0' },
      }),
    );
    await put(dir, 'app/_layout.tsx', 'export default function Layout() { return null; }\n');
    await put(dir, 'app/index.tsx', 'export default function Home() { return null; }\n');
    await put(dir, 'app/settings/profile.tsx', 'export default function Profile() { return null; }\n');
    await put(dir, 'src/components/Button.tsx', 'export const Button = () => null;\n');
    await put(dir, 'src/components/Button.test.tsx', 'it("works", () => {});\n');
    await put(dir, 'README.md', '# Expo demo\n');
    await git('add', '-A');
    await git('commit', '-qm', 'expo');

    const setup = await script('setup', ['--yes']);
    assert.equal(setup.code, 0, setup.stdout + setup.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /app\//, 'the router directory is an area');
    assert.match(text, /src\//, 'the source directory is an area');
    assert.match(text, /npm run lint/, 'a declared lint command should be recorded');

    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('refresh re-vendors, re-stamps and reinstalls the hook without touching the config', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await put(dir, 'vendor/x.js', '1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'vendor');
    await script('setup', ['--yes', '--exclude', 'vendor']);

    const configBefore = await read(dir, path.join('.naso', 'config.json'));

    // Something corrupts the vendored copy and the hook.
    await put(dir, path.join('.naso', 'tooling', 'validate.mjs'), '// stale\n');
    await rm(path.join(dir, '.git', 'hooks', 'pre-commit'), { force: true });

    const res = await script('refresh');
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const validate = await read(dir, path.join('.naso', 'tooling', 'validate.mjs'));
    assert.ok(!validate.includes('// stale'), 'the copy should have been replaced');
    assert.ok(await exists(dir, path.join('.git', 'hooks', 'pre-commit')), 'the hook should be back');
    assert.equal(
      await read(dir, path.join('.naso', 'config.json')),
      configBefore,
      'refresh must never rewrite config.json',
    );
  });
});

test('refresh never edits the briefing prose', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const edited = (await read(dir, AGENTS)).replace(
      '## Project Structure',
      '## Structure (I reworded this heading myself)',
    );
    await writeFile(path.join(dir, AGENTS), edited, 'utf8');

    await script('refresh');
    const after = await read(dir, AGENTS);
    assert.ok(after.includes('I reworded this heading myself'), 'refresh overwrote hand-written prose');
  });
});
