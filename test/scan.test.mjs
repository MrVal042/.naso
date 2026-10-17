// Reading a repository: areas, counts, package managers, conventions, aliases, tests and the gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { detectPackageManager } from '../tooling/lib.mjs';
import { topLevelEntries, areasOf, readFileIndex, scanRepo, parseTestTargets, findUncoveredTests, parseAliasBlocks, parseIgnorePatterns, extractInvocations, stepFamily, collapseSteps, parseWorkflowJobs } from '../tooling/briefing.mjs';
import {
  AGENTS,
  exec,
  withRepo,
  put,
  read,
  exists,
  seedProject,
  seedEgom,
  seedGroundTruth,
  sectionOf,
} from './helpers.mjs';

test('a gitignored build directory is not counted, described or listed', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, 'src/app.ts', 'export const a = 1;\n');
    await put(dir, '.gitignore', 'ios/build/\nnext-env.d.ts\n');
    await git('add', '-A');
    await git('commit', '-qm', 'app');

    // Ignored build output, on disk and never committed. An Expo/RN repository generates
    // hundreds of these on a single `expo prebuild`, and the old worktree view counted them.
    for (let i = 0; i < 25; i++) {
      await put(dir, `ios/build/Generated${i}.m`, '// generated\n');
    }
    await put(dir, 'next-env.d.ts', '/// <reference types="next" />\n');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    // Naming an ignored path as an ignore rule is correct; describing it as an area,
    // an entry point or part of any count is the bug this test exists for.
    assert.ok(
      !/^- `(?:ios|next-env)/m.test(text),
      `ignored build output must not be an area:\n${text}`,
    );
    assert.match(text, /3 tracked files, excluding AGENTS\.md/);

    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('readFileIndex reports its source and honours exclusions on the index view', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'vendor/x.js', 'module.exports = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'vendor');

    const all = await readFileIndex(dir);
    assert.equal(all.source, 'git');
    assert.ok(all.files.includes('vendor/x.js'));

    const filtered = await readFileIndex(dir, { exclude: ['vendor'] });
    assert.ok(!filtered.files.includes('vendor/x.js'));
    assert.equal(filtered.source, 'git');
  });
});

test('every command the briefing tells an agent to run uses pnpm and names a real script', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedEgom(dir, git);
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    const scripts = JSON.parse(await read(dir, 'package.json')).scripts;
    const commands = [...text.matchAll(/`((?:npm|pnpm|yarn|bun) run [\w:.-]+)`/g)].map((m) => m[1]);
    assert.ok(commands.length >= 5, `expected the gate and the checks, got: ${commands.join(', ')}`);
    for (const command of new Set(commands)) {
      const [manager, , name] = command.split(' ');
      assert.equal(manager, 'pnpm', `${command} must use the repository's manager`);
      assert.ok(name in scripts, `${command} names a script package.json does not declare`);
    }
    assert.match(text, /Package manager: pnpm \(from package\.json "packageManager": pnpm@9\.1\.0\)/);
  });
});

test('the lockfile decides when the manifest declares nothing', async () => {
  await withRepo(async ({ dir, git }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'locked', scripts: { test: 'node --test' } }));
    await put(dir, 'yarn.lock', '# yarn lockfile v1\n');
    await git('add', '-A');
    await git('commit', '-qm', 'yarn');

    const detected = await detectPackageManager(dir, JSON.parse(await read(dir, 'package.json')));
    assert.deepEqual(detected, { name: 'yarn', source: 'lock', evidence: 'yarn.lock' });
  });
});

test('with neither a field nor a lockfile, CI decides before npm is assumed', async () => {
  await withRepo(async ({ dir, git }) => {
    const pkg = { name: 'ci-only', scripts: {} };
    await put(dir, 'package.json', JSON.stringify(pkg));
    await put(
      dir,
      '.github/workflows/ci.yml',
      ['name: CI', 'on: [push]', 'jobs:', '  build:', '    steps:', '      - uses: actions/checkout@v4', '      - uses: pnpm/action-setup@v4', '      - run: pnpm install --frozen-lockfile', ''].join('\n'),
    );
    await git('add', '-A');
    await git('commit', '-qm', 'ci');

    const detected = await detectPackageManager(dir, pkg);
    assert.equal(detected.name, 'pnpm');
    assert.equal(detected.source, 'ci');

    await put(dir, 'src/a.ts', '1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'src');
    await rm(path.join(dir, '.github'), { recursive: true, force: true });

    const bare = await detectPackageManager(dir, pkg);
    assert.deepEqual(bare, {
      name: 'npm',
      source: 'default',
      evidence: 'no packageManager field, no lockfile',
    });
  });
});

test('extractInvocations keeps order, drops installs and dedupes', () => {
  const commands = extractInvocations(
    [
      'pnpm install --frozen-lockfile',
      'pnpm run typecheck',
      'pnpm run lint && pnpm run test',
      'pnpm exec expo check',
      'pnpm run test',
    ].join('\n'),
  );
  assert.deepEqual(commands, [
    'pnpm run typecheck',
    'pnpm run lint',
    'pnpm run test',
    'pnpm exec expo check',
  ]);
});

test('a dynamic run call is skipped rather than rendered as an unrunnable command', () => {
  assert.deepEqual(
    extractInvocations("for (const s of steps) { await run('pnpm', ['run', s]); }"),
    [],
  );
  assert.deepEqual(
    extractInvocations("await run('pnpm', ['run', 'check:secrets']);"),
    ['pnpm run check:secrets'],
  );
});

test('stepFamily and collapseSteps fold four boundary verifiers into one fact', () => {
  assert.equal(stepFamily('verify:boundary:auth'), 'boundary');
  assert.equal(stepFamily('check:deps'), 'deps');
  assert.equal(stepFamily('typecheck'), 'typecheck');

  assert.deepEqual(
    collapseSteps(['typecheck', 'lint', 'test', 'verify:boundary:auth', 'verify:boundary:payments', 'verify:boundary:db', 'verify:boundary:api']),
    ['typecheck', 'lint', 'test', 'boundary ×4'],
  );
});

test('parseWorkflowJobs reads inline and block run steps and ignores install', () => {
  const jobs = parseWorkflowJobs(
    [
      'name: CI',
      'on: [push]',
      'jobs:',
      '  verify:',
      '    name: verify',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: pnpm/action-setup@v4',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm run verify',
      '  release:',
      '    name: release',
      '    steps:',
      '      - run: |',
      '        pnpm run build',
      '        pnpm publish --access public',
      '',
    ].join('\n'),
  );
  assert.deepEqual(jobs.map((job) => job.name), ['verify', 'release']);
  assert.deepEqual(jobs[0].commands, ['pnpm run verify']);
  assert.deepEqual(jobs[1].commands, ['pnpm run build']);
});

test('the gate is one command plus what it subsumes, not a list of peers', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedEgom(dir, git);

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);

    assert.match(text, /One gate: `pnpm run verify` — the authority is `\.github\/workflows\/ci\.yml`, the verify job/);
    // The subsumed list, collapsed rather than repeated as four peer commands.
    assert.match(text, /It runs, in order \(read from `scripts\/verify\.mjs`\):[^.]*typecheck[^.]*lint[^.]*test[^.]*expo check[^.]*boundary ×4[^.]*check:secrets/s);
    // Subsumed commands must not reappear as peers.
    const peers = text.match(/Not run by the gate, so still yours to run: ([^\n]+)/)?.[1] ?? '';
    assert.ok(!peers.includes('lint'), `a subsumed command was listed again as a peer: ${peers}`);
    assert.ok(!peers.includes('test'), `a subsumed command was listed again as a peer: ${peers}`);

    // Enforcement scripts are named, each with whether the gate demonstrably runs it.
    assert.match(text, /Checks this repository names: `verify:boundary:auth` — in the gate;/);
    assert.match(text, /`check:secrets` — in the gate/);

    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('a tracked test file the test script never runs is named as a warning', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'gapped', scripts: { test: 'node --test test/' } }),
    );
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    await put(dir, 'test/unit.test.ts', "it('unit', () => {});\n");
    // Tracked, so it reads as covered by anyone who lists the tree — and named by no command.
    await put(dir, 'e2e/checkout.spec.ts', "describe('checkout', () => {});\n");
    await git('add', '-A');
    await git('commit', '-qm', 'gapped tests');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /runner node:test, 2 test files \(under `e2e\/`, `test\/`\), run by `npm run test` as `test\/`/);
    assert.match(
      text,
      /\*\*WARN\*\* `npm run test` runs `test\/`, and 1 tracked test file is outside it: e2e\/checkout\.spec\.ts\./,
    );
    // The setup screen says it too, not only the file.
    assert.match(res.stdout, /Warnings[\s\S]*e2e\/checkout\.spec\.ts/);
  });
});

test('a test script that names no path makes no coverage claim', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'open', scripts: { test: 'node --test' } }),
    );
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    await put(dir, 'e2e/checkout.spec.ts', "describe('checkout', () => {});\n");
    await git('add', '-A');
    await git('commit', '-qm', 'open tests');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /`npm run test` names no path, so it discovers its own inputs/);
    assert.ok(!/\*\*WARN\*\* `npm run test`/.test(text), 'no path means no claim, not a false alarm');
  });
});

test('parseTestTargets reads dirs, globs and bare runner arguments', () => {
  assert.deepEqual(parseTestTargets('node --test test/'), {
    targets: ['test/'],
    openEnded: false,
  });
  assert.deepEqual(parseTestTargets("mocha 'src/**/*.test.ts'"), {
    targets: ['src/**/*.test.ts'],
    openEnded: false,
  });
  assert.deepEqual(parseTestTargets('vitest run src'), { targets: ['src'], openEnded: false });
  // A script that names nothing discovers its own inputs.
  assert.deepEqual(parseTestTargets('jest --coverage'), { targets: [], openEnded: true });
  // Prose in a script is not a target.
  assert.deepEqual(parseTestTargets('echo "running the tests"'), { targets: [], openEnded: true });
});

test('findUncoveredTests compares tracked test files against what the script runs', () => {
  const files = ['test/a.test.ts', 'test/nested/b.spec.ts', 'e2e/c.test.ts', 'src/d.test.ts'];

  assert.deepEqual(findUncoveredTests(files, ['test/']), ['e2e/c.test.ts', 'src/d.test.ts']);
  assert.deepEqual(findUncoveredTests(files, ['test/', 'e2e/']), ['src/d.test.ts']);
  assert.deepEqual(findUncoveredTests(files, ['**/*.test.ts']), ['test/nested/b.spec.ts']);
  assert.deepEqual(findUncoveredTests(files, ['test/a.test.ts']), [
    'test/nested/b.spec.ts',
    'e2e/c.test.ts',
    'src/d.test.ts',
  ]);
});

test('every tracked root file is listed, however many there are', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'wide-root' }));
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    // A repository with a real root: dotfiles, lockfiles, CI config, per-tool configs.
    const rootFiles = [
      '.editorconfig',
      '.env.example',
      '.gitattributes',
      '.gitignore',
      '.nvmrc',
      '.prettierrc',
      '.watchmanconfig',
      'AGENTS.md.stub',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'babel.config.js',
      'eslint.config.mjs',
      'metro.config.js',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
    ];
    for (const file of rootFiles) await put(dir, file, '# x\n');
    await git('add', '-A');
    await git('commit', '-qm', 'wide root');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    const line = text.match(/^Root files, none of which is an area of its own: .*$/m)?.[0] ?? '';
    for (const file of rootFiles.filter((f) => f !== 'AGENTS.md.stub')) {
      assert.ok(line.includes(`\`${file}\``), `${file} is missing from the root file list: ${line}`);
    }
  });
});

test('an alias declared in babel but not tsconfig is named, with the file that misses it', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'aliased', type: 'module' }),
    );
    await put(
      dir,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
    );
    await put(
      dir,
      'babel.config.js',
      [
        'module.exports = {',
        "  plugins: [['module-resolver', { root: ['src'], alias: { '@legacy/*': 'src/legacy/*' } }]],",
        '};',
      ].join('\n'),
    );
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'aliases');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /Import aliases: @ → src \(tsconfig\.json as @\/\* — babel\.config\.js does not declare it\); @legacy → src\/legacy \(babel\.config\.js as @legacy\/\* — tsconfig\.json does not declare it\)\./);
    // The divergence is stated, not smoothed over.
    assert.match(text, /@legacy .*tsconfig\.json does not declare it/s);
    // And the rule that keeps the next alias from breaking the build.
    assert.match(
      text,
      /Aliases are declared in 2 files \(tsconfig\.json, babel\.config\.js\), so a new one must be added to all of them/,
    );
  });
});

test('the entry point is the one package.json declares, not a file named index', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'declared-entry', type: 'module', main: './server.js' }),
    );
    // A file called index.js exists; package.json says otherwise. The manifest wins.
    await put(dir, 'index.js', 'export const wrong = 1;\n');
    await put(dir, 'server.js', 'export const right = 1;\n');
    await put(dir, 'src/thing.ts', 'export const t = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'entry');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /The entry point is `server\.js` — package\.json "main"\./);
    // index.js is still listed as a file — it is tracked — but it is not offered as the
    // entry point, because nothing in package.json says it is.
    assert.ok(
      !/entry point is `index\.js`|index\.js is an entry point/.test(text),
      'a filename guess must not stand in for a declared entry',
    );
  });
});

test('a folder on the other module system is named instead of averaged away', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'two-systems', type: 'module' }));
    await put(dir, 'src/index.mjs', 'export const x = 1;\n');
    // CommonJS beside an ES modules repository, which one global line cannot express.
    await put(dir, 'plugins/legacy.cjs', 'module.exports = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'systems');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /Modules: ES modules \(package\.json declares "type": "module"\)\./);
    assert.match(text, /Not one module system throughout: `plugins\/` is CommonJS \(1 \.cjs file\)\./);
  });
});

test('parseAliasBlocks reads alias maps, and does not mistake root for one', () => {
  const babel = "module.exports = { plugins: [['module-resolver', { root: ['src'], alias: { '@/*': 'src/*' } }]] };";
  // `root: ['src']` changes what a relative import resolves against; it is not an alias.
  assert.deepEqual([...parseAliasBlocks(babel)], [['@/*', ['src/*']]]);

  const vite = "export default { resolve: { alias: { '@': './src' } } };";
  assert.deepEqual([...parseAliasBlocks(vite)], [['@', ['./src']]]);

  assert.deepEqual([...parseAliasBlocks('export default {};')], []);
});

test('these warnings stay out of AGENTS.md, which documents the repository as it is', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await put(dir, 'README.md', '# Demo\n\nRequires Node.js >= 18.\n');
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'demo', engines: { node: '>=20' }, scripts: { lint: 'echo lint' } }),
    );
    await put(dir, 'android/app/release.jks', 'x\n');
    await git('add', '-A');
    await git('commit', '-qm', 'drift');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Node version disagree/);

    const text = await read(dir, AGENTS);
    assert.ok(!text.includes('Node version disagree'), 'setup-only warning must not be written to AGENTS.md');
    assert.ok(!text.includes('credential-shaped'), 'setup-only warning must not be written to AGENTS.md');
  });
});

test('boundaries lead the section: enforced seams, then aliases, then ignores', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedEgom(dir, git);
    await put(
      dir,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['app/*'] } } }),
    );
    await git('add', '-A');
    await git('commit', '-qm', 'aliases');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    const section = text.slice(text.indexOf('## Boundaries'), text.indexOf('## Secrets'));

    // The repository's own enforced boundaries come first, each with the doc that holds
    // the rule and whether the gate runs it.
    // Every boundary verifier the gate runs is named and marked as run — not a count.
    for (const name of ['auth', 'payments', 'db', 'api']) {
      assert.match(section, new RegExp(`- \`verify:boundary:${name}\`[^\\n]*, runs in the gate`), `verify:boundary:${name}`);
    }
    assert.match(
      section,
      /- `verify:boundary:auth` \(`pnpm run verify:boundary:auth`\) — checks `scripts\/verify-boundary-auth\.mjs`, runs in the gate; the rule is in `docs\/boundaries\/auth\.md`\./,
    );

    // Aliases next.
    assert.match(section, /\*\*Import aliases\.\*\* @ → app\./);

    // Credentials from .gitignore, listed in full rather than truncated to fit.
    assert.match(section, /\*\*Credentials\.\*\* \.gitignore excludes [^.]*\*\.keystore/);
    assert.ok(
      section.indexOf('**Enforced checks.**') < section.indexOf('**Import aliases.**') &&
        section.indexOf('**Import aliases.**') < section.indexOf('**Credentials.**'),
      `boundaries must be ordered enforced, aliases, ignores:\n${section}`,
    );

    // The local exclude file is named as its own, non-shared mechanism.
    assert.match(
      section,
      /\*\*Local excludes\.\*\* \.git\/info\/exclude holds \.naso, AGENTS\.md, CLAUDE\.md on this machine only\./,
    );
  });
});

test('an unreadable gate does not claim the boundary scripts are not in it', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({
        name: 'opaque',
        scripts: {
          verify: 'node scripts/gate.mjs',
          'verify:boundary': 'node scripts/verify-boundary-auth.mjs',
          'verify:db-boundary': 'node scripts/verify-db-boundary.mjs',
        },
      }),
    );
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    await put(
      dir,
      '.github/workflows/ci.yml',
      'name: CI\non: [push]\njobs:\n  verify:\n    name: verify\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run verify\n',
    );
    // A gate NASO cannot read. It almost certainly runs both boundary scripts; NASO
    // cannot know that either way, and saying "not in the gate" is a claim.
    await put(
      dir,
      'scripts/gate.mjs',
      'const steps = process.env.STEPS.split(",");\nfor (const s of steps) await import(s);\n',
    );
    await put(dir, 'scripts/verify-boundary-auth.mjs', '// see docs/boundaries/auth.md\nexport const check = 1;\n');
    await put(dir, 'scripts/verify-db-boundary.mjs', '// see docs/boundaries/db.md\nexport const check = 1;\n');
    await put(dir, 'docs/boundaries/auth.md', '# auth\n');
    await put(dir, 'docs/boundaries/db.md', '# db\n');
    await git('add', '-A');
    await git('commit', '-qm', 'opaque gate');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    const section = text.slice(text.indexOf('## Boundaries'), text.indexOf('## Secrets'));

    // The gate could not be read, so membership is unknown — and unknown is not "no".
    assert.doesNotMatch(section, /not shown to run in the gate/);
    assert.match(section, /could not be read/);
    assert.match(section, /The gate could not be read \(scripts\/gate\.mjs\)/);
    assert.match(section, /whether it runs these scripts is unknown/);
    assert.match(section, /gate membership unknown/);

    // The scripts themselves are still reported, with their docs: those are facts.
    assert.match(section, /- `verify:boundary`[^\n]*`scripts\/verify-boundary-auth\.mjs`/);
    assert.match(section, /the rule is in `docs\/boundaries\/auth\.md`/);
  });
});

test('parseIgnorePatterns separates credentials from build output and reads negations', () => {
  const parsed = parseIgnorePatterns(
    ['node_modules/', 'dist/', '*.keystore', '*.p12', '.env*', '!src/app.ts', '# a comment'].join('\n'),
  );

  assert.deepEqual(parsed.credentials, ['*.keystore', '*.p12', '.env*']);
  assert.deepEqual(parsed.ordinary, ['node_modules/', 'dist/']);
  assert.deepEqual(parsed.negated, ['!src/app.ts']);
});

test('a gate that cannot be parsed says so and names the file instead of guessing', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'opaque', scripts: { verify: 'node scripts/gate.mjs' } }),
    );
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    // No invocable command anywhere in the file — the delegation is dynamic.
    await put(dir, 'scripts/gate.mjs', 'const steps = process.env.STEPS.split(",");\nfor (const s of steps) await import(s);\n');
    await git('add', '-A');
    await git('commit', '-qm', 'opaque gate');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /\*\*WARN\*\* The gate could not be parsed; see `scripts\/gate\.mjs`/);
    assert.ok(!/It runs, in order/.test(text), 'an unread gate must not claim a step list');
  });
});

test('a gate that invokes a different package manager is flagged', async () => {
  await withRepo(async ({ dir, git }) => {
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'mixed', packageManager: 'pnpm@9.1.0', scripts: { verify: 'npm run test' } }),
    );
    await put(dir, 'scripts/verify.mjs', "await run('npm', ['run', 'test']);\n");
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'mixed');

    const facts = await scanRepo(dir);
    assert.equal(facts.gate.managerMismatch, true);
    assert.deepEqual(facts.gate.managersUsed, ['npm']);
  });
});

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

test('Boundaries names every verify:* script the parsed gate runs, marked only when it does', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedGroundTruth(dir, git);
    const pkg = JSON.parse(await read(dir, 'package.json'));
    pkg.scripts['verify:orphan'] = 'node scripts/check-licenses.mjs';
    await put(dir, 'package.json', JSON.stringify(pkg));
    await git('commit', '-qam', 'an unwired check');

    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const boundaries = sectionOf(await read(dir, AGENTS), 'Boundaries');
    assert.match(boundaries, /- `verify:boundaries` \(`pnpm run verify:boundaries`\) — checks `scripts\/check-boundaries\.mjs`, runs in the gate/);
    assert.match(boundaries, /- `verify:licenses` \(`pnpm run verify:licenses`\) — checks `scripts\/check-licenses\.mjs`, runs in the gate/);
    assert.match(boundaries, /- `verify:orphan` .*not run by the gate/);
    assert.ok(!/`verify:orphan`[^\n]*runs in the gate/.test(boundaries), 'an unwired script must not be marked as run');
  });
});

test('@a in babel and @a/* in tsconfig are one alias; only @b is divergent', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedGroundTruth(dir, git);
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    assert.match(text, /Already divergent: @b \(missing from tsconfig\.json\)\./);
    assert.ok(!/@a[^\n]*missing from/.test(text), `@a is declared in both files:\n${sectionOf(text, 'Boundaries')}`);
    assert.match(text, /@a → src\/a \(tsconfig\.json as @a\/\*, babel\.config\.js\)/);
  });
});

test('a folder whose own package.json makes its .js CommonJS is named', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'esm-root', type: 'module' }));
    await put(dir, 'src/index.js', 'export const x = 1;\n');
    await put(dir, 'legacy/package.json', JSON.stringify({ name: 'legacy' }));
    await put(dir, 'legacy/a.js', 'module.exports = 1;\n');
    await put(dir, 'legacy/b.js', 'module.exports = 2;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'two systems by package.json');
    await bare(['--yes']);
    const text = await read(dir, AGENTS);
    assert.match(text, /`legacy\/` is CommonJS \(2 \.js files; legacy\/package\.json declares no "type"\)/);
    assert.ok(!/`src\/` is/.test(text), 'a folder on the repository default is not named');
  });
});

test('tests under test/ are not called co-located; a split layout is reported as a split', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedGroundTruth(dir, git);
    await bare(['--yes']);
    const tests = (await read(dir, AGENTS)).split('\n').find((line) => line.startsWith('Tests:'));
    assert.ok(!/2 test files co-located/.test(tests), tests);
    assert.match(tests, /2 test files \(1 co-located with source, 1 under `test\/`\)/);
  });
});

test('a test script that runs a script file makes no coverage claim', () => {
  for (const body of [
    './tooling/scripts/test-workspace.sh',
    'bash scripts/test.sh --ci',
    'node scripts/run-tests.mjs',
  ]) {
    assert.equal(parseTestTargets(body).openEnded, true, body);
  }
  assert.deepEqual(parseTestTargets('node --test test/a.test.mjs').targets, ['test/a.test.mjs']);
});

test('a Python repository is not told to use npm or package.json', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await put(dir, 'app.py', 'print(1)\n');
    await put(dir, 'requirements.txt', 'flask\n');
    await put(dir, 'templates/index.html', '<p></p>\n');
    await git('add', '-A');
    await git('commit', '-qm', 'py');

    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    assert.doesNotMatch(text, /npm/);
    assert.doesNotMatch(text, /package\.json/);
    assert.match(text, /Python dependencies: `requirements\.txt`/);
  });
});

test('the area holding package.json "bin" is the published command, and lib.mjs is not an entry', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'demo', bin: { demo: 'bin/demo.mjs' } }));
    await put(dir, 'bin/demo.mjs', '');
    await put(dir, 'tooling/lib.mjs', '');
    await put(dir, 'tooling/work.mjs', '');
    await git('add', '-A');
    await git('commit', '-qm', 'cli');

    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(text, /^- `bin\/` — published command \(package\.json "bin"\);/m);
    assert.doesNotMatch(text, /entry `tooling\/lib\.mjs`/);
  });
});

test('an area the published command imports is named as what it loads, not by its folder name', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'demo', bin: { demo: 'bin/demo.mjs' } }));
    await put(dir, 'bin/demo.mjs', "import { go } from '../tooling/core.mjs';\ngo();\n");
    await put(dir, 'tooling/core.mjs', 'export const go = () => {};\n');
    await put(dir, 'scripts/release.mjs', '');
    await git('add', '-A');
    await git('commit', '-qm', 'cli');
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(text, /^- `tooling\/` — code the published command loads \(`bin\/demo\.mjs` imports it\);/m);
    assert.match(text, /^- `scripts\/` — developer scripts;/m);
  });
});
