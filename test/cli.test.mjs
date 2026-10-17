// The other commands (guide, doctor, refresh), argument parsing, shared helpers and the package itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { coversUnit, countTodoMarkers, parseArgs, toolVersion, pathExists, compareVersions, splitNul, parseGitStatusPorcelainZ, unquoteGitPath, parseAddedLines, scanAddedLines } from '../tooling/lib.mjs';
import { normalizeExclusions } from '../tooling/vendor.mjs';
import {
  PACKAGE_ROOT,
  TOOL_DIR,
  BIN,
  AGENTS,
  STRIPE_FIXTURE,
  naso,
  filesIn,
  withRepo,
  put,
  read,
  exists,
  seedProject,
} from './helpers.mjs';

test('the README documents the bare command and not the retired pair', async () => {
  await withRepo(async ({ dir }) => {
    const readme = await read(PACKAGE_ROOT, 'README.md');

    assert.match(readme, /npx naso-dev --yes/, 'the scriptable path must be documented');
    assert.match(readme, /--why/, 'the long-form rationale must be documented');
    assert.match(readme, /NO_COLOR/, 'the colour opt-out must be documented');
    assert.ok(
      !/npx naso-dev (init|setup)/.test(readme),
      'the README must not send anybody to a retired command',
    );
  });
});

test('the README links only to files that exist, and names a real author', async () => {
  await withRepo(async ({ dir }) => {
    const readme = await read(PACKAGE_ROOT, 'README.md');

    // A link to a file that is not in the repository is a 404 for whoever clicks
    // it, and the one reader who cares is somebody trying to contribute.
    const links = [...readme.matchAll(/\]\(([^)#][^)]*)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(https?:|mailto:)/.test(target));
    for (const target of links) {
      const relPath = target.split('#')[0];
      assert.ok(await exists(PACKAGE_ROOT, relPath), `README links to ${target}, which does not exist`);
    }

    // The placeholders in a template must not survive into the shipped file.
    assert.doesNotMatch(readme, /your-handle|your-email|<repo-url>|TODO|FIXME|XXX/i);
    assert.match(readme, /@MrVal042/, 'the author handle must be the real one');
    assert.match(readme, /contactmrval@gmail\.com/);

    // CONTRIBUTING.md exists, and the README points at it rather than the reverse.
    const contributing = await read(PACKAGE_ROOT, 'CONTRIBUTING.md');
    assert.match(contributing, /fails before the fix/i, 'the fail-first rule must be stated');
  });
});

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

test('VERSION and package.json declare the same version', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const versionFile = (await readFile(path.join(PACKAGE_ROOT, 'VERSION'), 'utf8')).trim();
  assert.equal(versionFile, pkg.version);
  assert.equal(await toolVersion(), pkg.version);
});

test('the package is named naso-dev and the bin matches it', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'naso-dev');
  // The published form: npm strips a leading ./ from bin paths and warns if it has to,
  // so the manifest carries what npm ships rather than what it would rewrite on publish.
  assert.equal(pkg.bin['naso-dev'], 'bin/naso-dev.mjs');
  assert.ok(await pathExists(BIN));
});

test('package metadata points at the repository and gates a publish on the tests', async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.repository.url, /github\.com\/MrVal042\/\.naso/);
  assert.match(pkg.bugs.url, /github\.com\/MrVal042\/\.naso\/issues/);
  assert.ok(pkg.homepage.startsWith('https://github.com/MrVal042/.naso'));
  assert.equal(pkg.scripts.prepublishOnly, 'node --test test/*.test.mjs');
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
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

test('normalizeExclusions makes vendor, ./vendor and vendor/// one prefix', () => {
  assert.deepEqual(normalizeExclusions(['./vendor/', 'vendor', 'docs///', '']), ['docs', 'vendor']);
  assert.deepEqual(normalizeExclusions('not-an-array'), []);
});

test('guide <area> answers for one area and hands over a scope line', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await script('setup', ['--yes']);

    const res = await script('guide', ['src']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /src\//);
    assert.match(res.stdout, /NASO_SCOPE/);
    assert.match(res.stdout, /Tracked files under src\/: [1-9]/);
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

test('parseArgs: a boolean flag never consumes the next token, -y is --yes, --exclude repeats', () => {
  assert.deepEqual(
    (({ flags, positional }) => ({ yes: flags.has('yes'), positional }))(parseArgs(['--yes', 'some/dir'])),
    { yes: true, positional: ['some/dir'] },
  );
  const dry = parseArgs(['--dry-run', 'some/dir']);
  assert.ok(dry.flags.has('dry-run'));
  assert.deepEqual(dry.positional, ['some/dir']);
  for (const flag of ['track', 'no-hook', 'force', 'why', 'no-color']) {
    const parsed = parseArgs([`--${flag}`, 'dir']);
    assert.ok(parsed.flags.has(flag), `--${flag} must be a flag`);
    assert.deepEqual(parsed.positional, ['dir'], `--${flag} must not eat the directory`);
  }
  assert.ok(parseArgs(['-y']).flags.has('yes'));
  assert.deepEqual(parseArgs(['-y']).positional, []);
  const multi = parseArgs(['--exclude', 'a', '--exclude', 'b', '--exclude=c,d']);
  assert.deepEqual(multi.lists.get('exclude'), ['a', 'b', 'c,d']);
});

test('refresh drops generatedBy from an older config.json and keeps every other setting', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await bare(['--yes', '--exclude', 'src']);
    const config = JSON.parse(await read(dir, '.naso/config.json'));
    const legacy = { ...config, generatedBy: 'someone@somewhere' };
    await put(dir, '.naso/config.json', `${JSON.stringify(legacy, null, 2)}\n`);

    const res = await script('refresh');
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const after = JSON.parse(await read(dir, '.naso/config.json'));
    assert.ok(!('generatedBy' in after), 'refresh must drop generatedBy');
    const { generatedBy, ...rest } = legacy;
    assert.deepEqual(after, rest, 'every other setting must survive untouched');
  });
});

test('refresh says so when AGENTS.md was stamped by a newer NASO, and leaves the stamp', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await bare(['--yes']);
    const text = (await read(dir, AGENTS)).replace(/<!-- version: .+ -->/, '<!-- version: 9.9.9 -->');
    await put(dir, AGENTS, text);
    const res = await script('refresh');
    assert.match(res.stdout, /stamped 9\.9\.9, newer than this tool/);
    assert.ok(!/already stamped/.test(res.stdout));
    assert.match(await read(dir, AGENTS), /<!-- version: 9\.9\.9 -->/);
  });
});
