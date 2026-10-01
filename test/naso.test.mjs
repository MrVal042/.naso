#!/usr/bin/env node
// NASO's own test suite. Zero dependencies: node:test plus Node core modules.
//
// Every test builds a throwaway git repository in the OS temp dir and removes
// it afterwards, so the suite never depends on — or touches — a real project.
//
//   node --test test/
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coversUnit, countTodoMarkers, parseArgs } from '../scripts/lib.mjs';
import { extractPathTokens } from '../scripts/check-briefing.mjs';

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Spawn and collect stdout/stderr, never throwing on a non-zero exit. */
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

/** Create a temp git repo with one commit, run `fn`, then delete it. */
async function withRepo(fn) {
  const dir = await mkdtemp(path.join(path.sep, 'tmp', 'naso-test-'));
  const git = (...args) => exec('git', args, dir);
  const script = (name, args = []) =>
    exec(process.execPath, [path.join(TOOL_DIR, 'scripts', name), dir, ...args], dir);

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

/** Paths currently staged. */
const stagedNames = (dir) =>
  exec('git', ['diff', '--cached', '--name-only'], dir).then((r) =>
    r.stdout.split('\n').filter(Boolean),
  );

/** Write a file, creating parent directories. */
async function put(dir, relPath, contents = '') {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

// --- STEP 1: --refresh must not clobber a filled briefing -------------------

test('--refresh bumps the stamp without touching briefing content', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await script('bootstrap.mjs', ['--no-hook']);
    const agents = path.join(dir, 'AGENTS.md');
    const setupBefore = await readFile(path.join(dir, 'SETUP_INSTRUCTIONS.md'), 'utf8');

    // Stand in for a briefing an agent filled in from the real codebase.
    await put(
      dir,
      'AGENTS.md',
      '<!-- naso-briefing -->\n<!-- version: 0.9.0 -->\n' +
        '# Real Project\n\n## Project Structure\n\n- `src/` — the only area\n',
    );

    const res = await script('bootstrap.mjs', ['--refresh']);
    assert.equal(res.code, 0, res.stderr);
    const after = await readFile(agents, 'utf8');

    assert.match(after, /- `src\/` — the only area/, 'briefing content must survive');
    assert.doesNotMatch(after, /TODO\(fill\)/, 'must not be a fresh template');
    assert.doesNotMatch(after, /0\.9\.0/, 'stamp should have moved off 0.9.0');

    // --refresh must not touch the setup flow. The file legitimately exists from
    // the initial bootstrap; what matters is that its bytes are identical, since
    // rewriting it would send the next agent back through setup.
    const setupAfter = await readFile(path.join(dir, 'SETUP_INSTRUCTIONS.md'), 'utf8').catch(
      () => null,
    );
    assert.equal(setupAfter, setupBefore, '--refresh must not rewrite SETUP_INSTRUCTIONS.md');
  });
});

// --- STEP 4: guard blocking behaviour --------------------------------------

test('guard blocks a staged env file and allows .env.example', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, '.env.production', 'SECRET=value\n');
    await git('add', '-f', '.env.production');
    const blocked = await script('guard.mjs', ['--staged']);
    assert.equal(blocked.code, 1, 'a real env file must block the commit');
    assert.match(blocked.stdout, /ENV_FILE/);
    assert.match(blocked.stdout, /\.env\.production/);
    await git('reset', '-q');

    await rm(path.join(dir, '.env.production'));
    await put(dir, '.env.example', 'SECRET=\n');
    await git('add', '-f', '.env.example');
    const allowed = await script('guard.mjs', ['--staged']);
    assert.equal(allowed.code, 0, 'a committed .env.example must not block');
    await git('reset', '-q');
  });
});

test('guard blocks a staged file containing a PEM header', async () => {
  await withRepo(async ({ dir, git, script }) => {
    // Assembled at runtime from a repeated dash string so this file never holds
    // a literal PEM header for some other scanner to flag.
    const dashes = '-'.repeat(5);
    const header = `${dashes}BEGIN RSA PRIVATE KEY${dashes}`;
    await put(dir, 'fixture.txt', `${header}\nnot-real-key-material\n`);
    await git('add', 'fixture.txt');

    const res = await script('guard.mjs', ['--staged']);
    assert.equal(res.code, 1, 'a staged PEM header must block');
    assert.match(res.stdout, /PEM_PRIVATE_KEY/);
    assert.match(res.stdout, /fixture\.txt:1/, 'should report file and line');
    assert.doesNotMatch(res.stdout, /BEGIN RSA PRIVATE KEY/, 'never echo the matched text');
  });
});

test('keyword-named and warn-only paths do not block', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, 'design-tokens/x.ts', 'export const a = 1;\n');
    await put(dir, 'src/keyboard/y.ts', 'export const b = 2;\n');
    await put(dir, 'config/service-role.json', '{}\n');
    await git('add', 'design-tokens', 'src', 'config');

    const res = await script('guard.mjs', ['--staged']);
    assert.equal(res.code, 0, 'design-tokens, keyboard and COMPOUND must not block');
    assert.match(res.stdout, /warn-only/i, 'but COMPOUND should still be reported');
  });
});

// --- STEP 6: coverage boundary ---------------------------------------------

test('coversUnit rejects a longer path as coverage for a top-level unit', () => {
  const briefing = '- `apps/web/docs/` — docs for the web app\n- `src/` — source\n';
  assert.equal(coversUnit(briefing, 'docs/'), false, 'apps/web/docs/ must not cover docs/');
  assert.equal(coversUnit(briefing, 'src/'), true);

  assert.equal(coversUnit('- `mydocs/` — x\n', 'docs/'), false);
  assert.equal(coversUnit('- `src/tests/` — x\n', 'tests/'), false);
  assert.equal(coversUnit('- `Docs/` — x\n', 'docs/'), true, 'case-insensitive');
  assert.equal(coversUnit('- `docs/` — x\n', 'docs/'), true);
});

test('countTodoMarkers counts both marker kinds', () => {
  assert.equal(countTodoMarkers('a TODO(fill) b TODO(describe) c TODO(fill)'), 3);
  assert.equal(countTodoMarkers('clean file'), 0);
});

test('extractPathTokens skips flags, globs and NASO script names', () => {
  const tokens = extractPathTokens(
    'use `git status` not `git add -A`; see `src/` and `docs/api.md`; `validate.mjs`; `x*`',
  );
  assert.deepEqual(tokens, ['docs/api.md', 'src/']);
});

test('parseArgs reads --key value and --key=value', () => {
  const { flags, values, positional } = parseArgs(['--staged', '--scope', 'a,b', '--x=1', 'p']);
  assert.ok(flags.has('staged'));
  assert.equal(values.get('scope'), 'a,b');
  assert.equal(values.get('x'), '1');
  assert.deepEqual(positional, ['p']);
});

// --- STEP 7: scope ---------------------------------------------------------

test('scope warns out-of-scope paths, and --strict blocks them', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, 'src/a.ts', 'export const a = 1;\n');
    await put(dir, 'unrelated/b.ts', 'export const b = 2;\n');
    await git('add', 'src', 'unrelated');

    const warned = await script('guard.mjs', ['--staged', '--scope', 'src']);
    assert.equal(warned.code, 0, 'scope is warn-only without --strict');
    assert.match(warned.stdout, /Out-of-scope paths changed/);
    assert.match(warned.stdout, /unrelated\/b\.ts/);

    const strict = await script('guard.mjs', ['--staged', '--scope', 'src', '--strict']);
    assert.equal(strict.code, 1, '--strict must block an out-of-scope path');
  });
});

test('AGENTS.md is always in scope', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, 'src/a.ts', 'export const a = 1;\n');
    await put(dir, 'AGENTS.md', '# briefing\n');
    await git('add', '-f', 'AGENTS.md', 'src');

    const res = await script('guard.mjs', ['--staged', '--scope', 'src', '--strict']);
    assert.equal(res.code, 0, 'the briefing must never count as out-of-scope');
  });
});

// --- STEP 3: append staging ------------------------------------------------

test('append stages AGENTS.md only when tracked with no unstaged edits', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await script('bootstrap.mjs', ['--no-hook']);
    const agents = path.join(dir, 'AGENTS.md');
    await rm(path.join(dir, 'SETUP_INSTRUCTIONS.md'), { force: true });

    // Case 1: excluded and untracked — must not be staged.
    await put(dir, 'billing/x.ts', 'export const x = 1;\n');
    await git('add', 'billing');
    await script('validate.mjs', ['--staged']);
    assert.ok(
      !(await stagedNames(dir)).includes('AGENTS.md'),
      'ignored briefing must not be staged',
    );

    // Case 2: tracked, but a human has it open — must not be staged.
    await git('add', '-f', 'AGENTS.md');
    await git('commit', '-qm', 'briefing');
    await appendFile(agents, '\n- human edit in progress\n');
    await put(dir, 'ledger/l.ts', 'export const l = 1;\n');
    await git('add', 'ledger');
    await script('validate.mjs', ['--staged']);
    assert.ok(
      !(await stagedNames(dir)).includes('AGENTS.md'),
      'must not stage a briefing with unstaged edits',
    );
    assert.match(await readFile(agents, 'utf8'), /human edit in progress/, 'edit must survive');

    // Case 3: tracked and clean — must be staged.
    await git('checkout', '-q', '--', 'AGENTS.md');
    await git('reset', '-q');
    await put(dir, 'reports/r.ts', 'export const r = 1;\n');
    await git('add', 'reports');
    await script('validate.mjs', ['--staged']);
    assert.ok(
      (await stagedNames(dir)).includes('AGENTS.md'),
      'a clean tracked briefing should be staged',
    );
  });
});

// --- STEP 6: check-briefing ------------------------------------------------

test('check-briefing reports missing, uncovered and unfilled', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await script('bootstrap.mjs', ['--no-hook']);
    const res = await script('check-briefing.mjs', []);
    assert.equal(res.code, 1, 'a fresh template must fail its own check');
    assert.match(res.stdout, /UNFILLED/);

    // A briefing that covers the repo and claims nothing false passes.
    await put(dir, 'AGENTS.md', '# Real\n\n- `seed.txt` — the only file\n');
    const clean = await script('check-briefing.mjs', []);
    assert.equal(clean.code, 0, clean.stdout);

    // Claiming a path that is not there must fail.
    await appendFile(path.join(dir, 'AGENTS.md'), '\n- `does/not/exist/` — invented\n');
    const bogus = await script('check-briefing.mjs', []);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stdout, /MISSING/);
    assert.match(bogus.stdout, /does\/not\/exist/);
  });
});
