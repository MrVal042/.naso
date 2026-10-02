#!/usr/bin/env node
// NASO's own test suite. Zero dependencies: node:test plus Node core modules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coversUnit, countTodoMarkers, parseArgs } from '../tooling/lib.mjs';
import { extractPathTokens } from '../tooling/briefing.mjs';

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
