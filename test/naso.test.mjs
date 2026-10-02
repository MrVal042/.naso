#!/usr/bin/env node
// NASO's own test suite. Zero dependencies: node:test plus Node core modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coversUnit, countTodoMarkers, parseArgs, toolVersion, pathExists } from '../tooling/lib.mjs';
import { extractPathTokens } from '../tooling/briefing.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_DIR = path.join(PACKAGE_ROOT, 'tooling');

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

async function filesIn(dir, suffixes) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && suffixes.some((s) => entry.name.endsWith(s))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

async function withRepo(fn) {
  const dir = await mkdtemp(path.join(path.sep, 'tmp', 'naso-test-'));
  const git = (...args) => exec('git', args, dir);
  const script = (name, args = []) =>
    exec(process.execPath, [path.join(TOOL_DIR, 'tooling', name), dir, ...args], dir);

  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'NASO Test');
    await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
    await git('add', 'seed.txt');
    await git('commit', '-qm', 'init');
    return await fn({ dir, git, script });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const stagedNames = (dir) =>
  exec('git', ['diff', '--cached', '--name-only'], dir).then((r) =>
    r.stdout.split('\n').filter(Boolean),
  );

async function put(dir, relPath, contents = '') {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

// lib tests
test('coversUnit matches tokens with escaping', () => {
  const text = 'See `docs/README.md`. Also check `foo/bar-baz.txt`.';
  assert.ok(coversUnit(text, 'docs/README.md'));
  assert.ok(coversUnit(text, 'foo/bar-baz.txt'));
  assert.ok(!coversUnit(text, 'missing/file.txt'));
});

test('countTodoMarkers counts TODO(fill) and TODO(describe)', () => {
  const txt = 'TODO(fill) and TODO(describe) TODO(other)';
  assert.equal(countTodoMarkers(txt), 2);
});

test('parseArgs handles flags and positionals', () => {
  const { flags, positional } = parseArgs(['dir', '--track', '--no-hook', 'extra']);
  assert.ok(flags.has('track'));
  assert.ok(flags.has('track'));
  assert.equal(positional[0], 'dir');
});

// briefing extract
test('extractPathTokens pulls backtick-quoted paths', () => {
  const tokens = extractPathTokens('- `src/foo.ts` — does a thing\n`docs/guide.md`');
  assert.deepEqual(new Set(tokens), new Set(['src/foo.ts', 'docs/guide.md']));
});

// version identity
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
  assert.ok(await pathExists(path.join(PACKAGE_ROOT, 'bin', 'naso-dev.mjs')));
});

test('no printed text suggests `npx naso` or hardcodes a home directory', async () => {
  const sources = [
    ...(await filesIn(path.join(PACKAGE_ROOT, 'tooling'), ['.mjs', '.md'])),
    path.join(PACKAGE_ROOT, 'bin', 'naso-dev.mjs'),
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
