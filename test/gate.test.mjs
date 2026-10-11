// The pre-commit gate and the vendored copy it runs: secrets, scope, renames and new areas.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolVersion, pathExists } from '../tooling/lib.mjs';
import { notableAdditions, inScope, resolveScope } from '../tooling/validate.mjs';
import { buildHookScript, isNasoHook, removeArtifacts } from '../tooling/install.mjs';
import { acquire } from '../tooling/lock.mjs';
import { vendorTooling, isVendored, vendoredVersion } from '../tooling/vendor.mjs';
import {
  PACKAGE_ROOT,
  TOOL_DIR,
  BIN,
  AGENTS,
  STRIPE_FIXTURE,
  GITHUB_FIXTURE,
  exec,
  naso,
  filesIn,
  withRepo,
  put,
  read,
  exists,
  seedProject,
} from './helpers.mjs';

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

test('nothing vendored imports a package, because the hook has no node_modules', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);

    const vendored = await filesIn(path.join(dir, '.naso', 'tooling'), ['.mjs']);
    const names = vendored.map((file) => path.basename(file));

    // The two modules that carry dependencies are the ones that must not be here.
    assert.ok(!names.includes('ui.mjs'), 'ui.mjs imports picocolors and must not be vendored');
    assert.ok(!names.includes('flow.mjs'), 'flow.mjs imports @clack/prompts and must not be vendored');

    // The general rule, so the next module somebody adds is caught here rather
    // than by a pre-commit hook failing on somebody else's machine.
    const bare = [];
    for (const file of vendored) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g)) {
        const spec = match[1];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        bare.push(`${path.basename(file)} → ${spec}`);
      }
    }
    assert.deepEqual(bare, [], `vendored modules must not import packages:\n${bare.join('\n')}`);
  });
});

test('a vendored copy reports its own version, not 0.0.0', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await vendorTooling(dir);

    // The vendored copy reads its VERSION from beside itself. When it did not, the
    // gate warned on every commit that AGENTS.md came from a newer NASO than the
    // one running it — permanently, on every repository, with no way to fix it.
    // Read through the vendored copy itself, not through this package's own copy:
    // the bug was that the two disagree, so testing the wrong one proves nothing.
    const vendoredLib = pathToFileURL(path.join(dir, '.naso', 'tooling', 'lib.mjs')).href;
    const { toolVersion: vendoredToolVersion } = await import(vendoredLib);

    assert.notEqual(await vendoredToolVersion(), '0.0.0', 'the vendored copy must find its own VERSION');
    assert.equal(await vendoredToolVersion(), await toolVersion());
  });
});

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
    // An installed package has its dependencies; what goes away below is the package.
    await exec('ln', ['-s', path.join(PACKAGE_ROOT, 'node_modules'), path.join(copy, 'node_modules')]);

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

test('validate spawns pnpm, never npm or npx, in a pnpm repository (full and staged)', async () => {
  await withRepo(async ({ dir, git }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({
        name: 'pnpm-repo',
        packageManager: 'pnpm@9.1.0',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test' },
      }),
    );
    await put(dir, '.prettierrc', '{}\n');
    await put(dir, '.gitignore', 'node_modules/\n');
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    for (const bin of ['prettier', 'eslint', 'tsc']) {
      await put(dir, `node_modules/.bin/${bin}`, '#!/bin/sh\nexit 0\n');
      await chmod(path.join(dir, `node_modules/.bin/${bin}`), 0o755);
    }
    await git('add', '-A');
    await git('commit', '-qm', 'pnpm repo');

    // Stand-ins for every manager, so what validate *spawns* is recorded rather than
    // what it prints.
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'naso-fakebin-'));
    const log = path.join(fakeBin, 'calls.log');
    try {
      for (const name of ['pnpm', 'npm', 'npx', 'yarn', 'bun', 'bunx']) {
        await writeFile(path.join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
        await chmod(path.join(fakeBin, name), 0o755);
      }
      const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };

      const full = await exec(process.execPath, [path.join(TOOL_DIR, 'validate.mjs'), dir], dir, env);
      assert.equal(full.code, 0, full.stdout + full.stderr);

      await put(dir, 'src/more.ts', 'export const y = 2;\n');
      await git('add', 'src/more.ts');
      const staged = await exec(
        process.execPath,
        [path.join(TOOL_DIR, 'validate.mjs'), dir, '--staged', '--no-append'],
        dir,
        env,
      );
      assert.equal(staged.code, 0, staged.stdout + staged.stderr);

      const calls = (await readFile(log, 'utf8')).trim().split('\n');
      const managers = [...new Set(calls.map((line) => line.split(' ')[0]))];
      assert.deepEqual(managers, ['pnpm'], `only pnpm may be spawned:\n${calls.join('\n')}`);
      for (const expected of [
        'pnpm run lint',
        'pnpm run typecheck',
        'pnpm run test',
        'pnpm exec prettier --check .',
        'pnpm exec prettier --check --ignore-unknown src/more.ts',
        'pnpm exec eslint src/more.ts',
      ]) {
        assert.ok(calls.includes(expected), `expected \`${expected}\` in:\n${calls.join('\n')}`);
      }
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});

test('validate full run honours --scope and --strict, not only the environment', async () => {
  await withRepo(async ({ dir, git }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'scoped' }));
    await put(dir, 'src/a.ts', 'export const a = 1;\n');
    await put(dir, 'docs/b.md', '# b\n');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    await put(dir, 'docs/b.md', '# b, changed\n');

    const validate = (args) => exec(process.execPath, [path.join(TOOL_DIR, 'validate.mjs'), dir, ...args], dir, { NASO_SCOPE: '', NASO_SCOPE_STRICT: '' });
    const loose = await validate([]);
    assert.equal(loose.code, 0, loose.stdout);
    const strict = await validate(['--scope', 'src', '--strict']);
    assert.equal(strict.code, 1, strict.stdout);
    assert.match(strict.stdout, /Out-of-scope paths changed[\s\S]*docs\/b\.md/);
  });
});

test('removeArtifacts reports a file it could not delete instead of claiming it did', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naso-rm-'));
  const locked = path.join(dir, 'locked');
  await mkdir(locked);
  await writeFile(path.join(locked, '.naso.lock'), 'x');
  await chmod(locked, 0o555);
  try {
    const result = await removeArtifacts([{ path: path.join(locked, '.naso.lock'), label: '.naso.lock', owned: 'yes' }]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /EACCES|EPERM/);
  } finally {
    await chmod(locked, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock that cannot be released is reported, not silently left behind', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naso-lock-'));
  const lock = await acquire(dir);
  assert.ok(lock.acquired);
  await chmod(dir, 0o555);
  const said = [];
  const original = console.error;
  console.error = (...args) => said.push(args.join(' '));
  try {
    await lock.release();
  } finally {
    console.error = original;
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(said.some((line) => /\.naso\.lock/.test(line) && /remove it by hand/.test(line)), said.join('\n'));
});
