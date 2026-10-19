// The setup flow: the plan, the questions, what it writes, hooks, local excludes and CLAUDE.md.

import test from 'node:test';
import { vendorSources } from '../tooling/vendor.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolVersion, pathExists } from '../tooling/lib.mjs';
import { NASO_START } from '../tooling/briefing.mjs';
import { isNasoHook } from '../tooling/install.mjs';
import { isVendored } from '../tooling/vendor.mjs';
import {
  TOOL_DIR,
  BIN,
  AGENTS,
  driveFlow,
  exec,
  naso,
  withRepo,
  put,
  treeHash,
  plainStyleForTest,
  read,
  exists,
  seedProject,
  allFiles,
  FOREIGN_HOOK,
  plannedWrites,
  linesIn,
  answerRealQuestions,
} from './helpers.mjs';

test('with no terminal and no --yes: the plan is printed, nothing is written, exit 2 names --yes and --dry-run', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);

    const res = await bare([]);
    assert.equal(res.code, 2, 'an unanswerable run must not look like a successful one');
    assert.match(res.stdout, /Files\s+5 tracked in the git index/, 'it reads first');
    assert.match(res.stdout, /Files this writes/, 'then shows the plan');
    assert.match(res.stdout + res.stderr, /--yes/);
    assert.match(res.stdout + res.stderr, /--dry-run/);
    assert.equal(await treeHash(dir), before, 'nothing may change, .git included');
  });
});

test('--dry-run prints the same plan, writes nothing and exits 0', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const res = await bare(['--dry-run']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Files this writes/);
    assert.equal(await treeHash(dir), before);
  });
});

test('bare --yes writes the briefing exactly as the retired setup command would', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);

    const viaBare = await bare(['--yes']);
    assert.equal(viaBare.code, 0, viaBare.stdout + viaBare.stderr);
    const fromBare = await read(dir, AGENTS);

    await rm(path.join(dir, AGENTS), { force: true });
    await rm(path.join(dir, '.naso'), { recursive: true, force: true });

    const viaSetup = await script('setup', ['--yes']);
    assert.equal(viaSetup.code, 0, viaSetup.stdout + viaSetup.stderr);
    const fromSetup = await read(dir, AGENTS);

    // Same bytes, so the two paths cannot drift apart as they are maintained.
    assert.equal(fromBare, fromSetup);
  });
});

test('answering the questions and accepting writes the briefing, the toolset and the hook', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { decisions: ['accept'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.deepEqual(res.events.map((event) => event.ask), ['questions', 'decide']);
    assert.match(await read(dir, AGENTS), /naso:start/);
    assert.ok(await isVendored(dir), 'the toolset must be vendored');
    assert.ok(isNasoHook({ body: await read(dir, '.git/hooks/pre-commit') }), 'the hook must be installed');
  });
});

test('cancelling at the first question leaves the whole tree, .git included, byte-identical', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const res = await driveFlow(dir, { questions: null });
    assert.equal(res.code, 0, 'a cancelled install is a decision, not a failure');
    assert.equal(await treeHash(dir), before);
    assert.match(res.events.at(-1).done, /Cancelled\. Nothing was written/);
  });
});

test('colour precedence: --no-color, then NO_COLOR, then FORCE_COLOR or --color, then the terminal', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const esc = /\u001B\[[0-9;]*m/;
    const run = (args, env = {}) => exec(process.execPath, [BIN, dir, '--dry-run', ...args], dir, env);

    const cases = [
      [[], {}, false, 'a pipe with nothing set is plain'],
      [[], { FORCE_COLOR: '1' }, true, 'FORCE_COLOR colours a pipe'],
      [[], { FORCE_COLOR: '0' }, false, 'FORCE_COLOR=0 asks for none'],
      [['--color'], {}, true, '--color colours a pipe'],
      [[], { NO_COLOR: '1', FORCE_COLOR: '1' }, false, 'NO_COLOR beats FORCE_COLOR'],
      [['--color'], { NO_COLOR: '1' }, false, 'NO_COLOR beats --color'],
      [['--no-color'], { FORCE_COLOR: '1' }, false, '--no-color beats FORCE_COLOR'],
    ];
    for (const [args, env, coloured, why] of cases) {
      const res = await run(args, env);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.equal(esc.test(res.stdout), coloured, why);
      assert.match(res.stdout.replace(/\u001B\[[0-9;]*m/g, ''), /Files\s+\d+ tracked in the git index/, `${why}: text intact`);
    }
  });
});

test('init and setup still run, warn once, and are hidden from the command list', async () => {
  await withRepo(async ({ dir, git, script, bare }) => {
    await seedProject(dir, git);

    const help = await naso(['--help'], dir);
    assert.doesNotMatch(help.stdout, /naso-dev init/);
    assert.doesNotMatch(help.stdout, /naso-dev setup/);
    assert.match(help.stdout, /naso-dev \[target-dir\]/, 'the bare command is the documented entry point');
    // The commands that are still there must still be listed.
    assert.match(help.stdout, /naso-dev briefing/);
    assert.match(help.stdout, /naso-dev doctor/);

    const init = await script('init');
    assert.equal(init.code, 0, init.stdout + init.stderr);
    const initOut = init.stdout + init.stderr;
    assert.match(initOut, /deprecated/);
    assert.match(initOut, /npx naso-dev\b/, 'it must name the replacement');
    // One warning, not one per line of its own prose.
    assert.equal(initOut.match(/deprecated/gi).length, 1);

    const setup = await script('setup', ['--yes']);
    assert.equal(setup.code, 0, setup.stdout + setup.stderr);
    assert.match(setup.stdout + setup.stderr, /deprecated/);
    assert.ok(await exists(dir, AGENTS), 'the retired command must still do its job');
  });
});

test('setup flags a README that disagrees with the declared Node version, and a tracked keystore, without reading either', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);

    // The four places the same fact is written, three of them disagreeing with the first.
    await put(dir, 'README.md', '# Demo\n\nRequires Node.js >= 18 to run the tests.\n');
    await put(
      dir,
      'package.json',
      JSON.stringify({
        name: 'demo',
        engines: { node: '>=20' },
        scripts: { lint: 'echo lint' },
      }),
    );
    await put(dir, '.nvmrc', '20.11.0\n');
    await put(
      dir,
      '.github/workflows/ci.yml',
      'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n',
    );

    // Committed before the ignore rule existed, which is how this actually happens:
    // the pattern is added later and the tracked file is never noticed.
    const secret = 'not-a-real-key\n';
    await put(dir, 'android/app/upload-keystore.jks', secret);
    await git('add', '-A');
    await git('commit', '-qm', 'keystore');
    await put(dir, '.gitignore', 'node_modules/\n*.jks\n');
    await git('add', '-A');
    await git('commit', '-qm', 'ignore rules');

    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const out = res.stdout;

    assert.match(out, /README\.md and the declared Node version disagree/);
    assert.match(out, /README claims Node 18; package\.json engines\.node says >=20; \.nvmrc says 20\.11\.0; \.github\/workflows\/ci\.yml node-version says 20/);

    assert.match(out, /1 credential-shaped file is tracked in git/);
    assert.match(out, /android\/app\/upload-keystore\.jks — path only, contents not read\./);
    assert.match(out, /will not appear in git status/);

    // The point of "path only": the bytes never leave the repository.
    assert.ok(!out.includes('not-a-real-key'), 'setup must not print the file contents');

    // Nothing was fixed, nothing was staged, nothing was written.
    const status = (await git('status', '--porcelain')).stdout.trim();
    assert.equal(status, '', `setup must not modify the repository:\n${status}`);
    const readme = await read(dir, 'README.md');
    assert.match(readme, /Requires Node\.js >= 18/, 'README must be left as the repository wrote it');
  });
});

test('a README that agrees with every declaration is not flagged', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    await put(dir, 'README.md', '# Demo\n\nRequires Node.js >= 20.\n');
    await put(
      dir,
      'package.json',
      JSON.stringify({ name: 'demo', engines: { node: '>=20' }, scripts: { lint: 'echo lint' } }),
    );
    await git('add', '-A');
    await git('commit', '-qm', 'agreed');

    const res = await script('setup', ['--yes']);
    assert.doesNotMatch(res.stdout, /Node version disagree/);
    assert.doesNotMatch(res.stdout, /credential-shaped file/);
  });
});

test('setup --yes writes the briefing, the toolset, the config and the hook', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    assert.ok(await exists(dir, AGENTS));
    assert.ok(await exists(dir, path.join('.naso', 'tooling', 'validate.mjs')));
    assert.ok(await exists(dir, path.join('.naso', 'config.json')));

    const config = JSON.parse(await read(dir, path.join('.naso', 'config.json')));
    assert.equal(config.setupVersion, await toolVersion());
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

test('the retired setup command, with no terminal, writes nothing, exits 2 and says what replaced it', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const res = await script('setup');
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /deprecated — `npx naso-dev` now does this/);
    assert.equal(await treeHash(dir), before, 'nothing may change, .git included');
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

test('`naso-dev --yes <dir>` from another directory sets up <dir>', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'naso-cwd-'));
    try {
      const res = await exec(process.execPath, [BIN, '--yes', dir], elsewhere);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.ok(await exists(dir, AGENTS), '--yes <dir> must write AGENTS.md in <dir>');
      assert.ok(!(await pathExists(path.join(elsewhere, AGENTS))), 'and nothing in the cwd');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

test('`naso-dev --dry-run <dir>` plans <dir>, writes nothing, exits 0', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'naso-cwd-'));
    try {
      const res = await exec(process.execPath, [BIN, '--dry-run', dir], elsewhere);
      assert.equal(res.code, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /src\/index\.ts|`src\/`/, 'the plan must describe <dir>, not the cwd');
      assert.ok(!(await exists(dir, AGENTS)));
      assert.ok(!(await exists(dir, '.naso')));
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

test('`naso-dev -y` sets up the current directory', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await exec(process.execPath, [BIN, '-y'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(await exists(dir, AGENTS));
  });
});

test('--exclude given twice keeps both areas out and saves both', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, 'a/one.ts', 'export {};\n');
    await put(dir, 'b/two.ts', 'export {};\n');
    await git('add', '-A');
    await git('commit', '-qm', 'areas');
    const res = await bare(['--yes', '--exclude', 'a', '--exclude', 'b']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const config = JSON.parse(await read(dir, '.naso/config.json'));
    assert.deepEqual(config.exclude, ['a', 'b']);
    const text = await read(dir, AGENTS);
    assert.ok(!text.includes('`a/`') && !text.includes('`b/`'), 'neither excluded area may be described');
  });
});

test('no user@host string appears in any output or any written file', async () => {
  const actor = `${os.userInfo().username}@${os.hostname()}`;
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);

    const outputs = [];
    const keep = (res) => outputs.push(res.stdout, res.stderr);
    keep(await bare(['--yes']));
    keep(await script('briefing', ['create', '--force']));
    keep(await script('refresh'));
    keep(await script('doctor'));
    keep(await script('guide', ['--list']));
    keep(await script('init'));
    keep(await script('validate'));
    await put(dir, 'src/more.ts', 'export const z = 3;\n');
    await git('add', 'src/more.ts');
    keep(await git('commit', '-qm', 'through the hook'));

    for (const [i, text] of outputs.entries()) {
      assert.ok(!text.includes(actor), `output #${i} names ${actor}:\n${text}`);
    }
    for (const file of await allFiles(dir)) {
      const text = await readFile(path.join(dir, file), 'utf8').catch(() => '');
      assert.ok(!text.includes(actor), `${file} names ${actor}`);
    }
    const config = JSON.parse(await read(dir, '.naso/config.json'));
    assert.ok(!('generatedBy' in config), 'config.json must not carry generatedBy');
    assert.ok(!/generated-by:/.test(await read(dir, AGENTS)), 'the AGENTS.md header must not carry generated-by');
  });
});

test('a foreign hook is named in the plan, kept byte for byte, and setup still writes the briefing', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.git/hooks/pre-commit', FOREIGN_HOOK);
    await chmod(path.join(dir, '.git/hooks/pre-commit'), 0o755);

    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Hook: existing hook at \S*\.git\/hooks\/pre-commit/);
    assert.ok(await exists(dir, AGENTS), 'a foreign hook must not stop the briefing being written');
    assert.equal(await read(dir, '.git/hooks/pre-commit'), FOREIGN_HOOK, 'the foreign hook must be untouched');
  });
});

test('chain moves the foreign hook aside unchanged and runs it before the gate', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.git/hooks/pre-commit', FOREIGN_HOOK);
    await chmod(path.join(dir, '.git/hooks/pre-commit'), 0o755);

    const res = await bare(['--yes', '--hook-action', 'chain']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(await read(dir, '.git/hooks/pre-commit.pre-naso'), FOREIGN_HOOK);
    assert.ok(isNasoHook({ body: await read(dir, '.git/hooks/pre-commit') }));

    await put(dir, 'src/next.ts', 'export const n = 1;\n');
    await git('add', 'src/next.ts');
    const commit = await git('commit', '-qm', 'through both hooks');
    assert.equal(commit.code, 0, commit.stdout + commit.stderr);
    assert.ok(await exists(dir, '.foreign-hook-ran'), 'the chained hook must run on commit');
  });
});

test('abort at a foreign hook leaves the whole tree, .git included, byte-identical', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.git/hooks/pre-commit', FOREIGN_HOOK);
    const before = await treeHash(dir);
    const res = await bare(['--yes', '--hook-action', 'abort']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(await treeHash(dir), before);
  });
});

test('a tracked core.hooksPath is not written to unless the user chooses it', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.husky/commit-msg', '#!/bin/sh\nexit 0\n');
    await git('add', '.husky');
    await git('commit', '-qm', 'husky');
    await git('config', 'core.hooksPath', '.husky');

    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(await exists(dir, AGENTS));
    assert.ok(!(await exists(dir, '.husky/pre-commit')), 'nothing may be written into a tracked hooks directory');
    assert.equal((await git('status', '--porcelain', '--', '.husky')).stdout, '');
    assert.match(res.stdout, /core\.hooksPath is \.husky, a directory git tracks/);

    const chosen = await bare(['--yes', '--force', '--hook-action', 'install']);
    assert.equal(chosen.code, 0, chosen.stdout + chosen.stderr);
    assert.ok(isNasoHook({ body: await read(dir, '.husky/pre-commit') }), 'an explicit choice writes it');
  });
});

test('a hand-written AGENTS.md is not "already set up": the NASO block is appended', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Ours\n\nHand-written.\n');
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    assert.ok(text.startsWith('# Ours\n\nHand-written.\n'));
    assert.ok(text.includes(NASO_START), 'the block must be appended');
  });
});

test('a NASO-owned re-run is reported without --force and regenerates only the block with it', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await put(dir, AGENTS, `# Mine\n\nKeep me.\n\n${await read(dir, AGENTS)}`);
    await put(dir, 'docs/guide.md', '# Guide\n');
    await git('add', 'docs/guide.md');
    await git('commit', '-qm', 'docs', '--no-verify');
    const before = await read(dir, AGENTS);

    const again = await bare(['--yes']);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /Already set up/);
    assert.equal(await read(dir, AGENTS), before, 'without --force nothing changes');

    const forced = await bare(['--yes', '--force']);
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    const after = await read(dir, AGENTS);
    assert.ok(after.startsWith('# Mine\n\nKeep me.\n\n'), 'prose outside the markers survives');
    assert.match(after, /`docs\/`/, 'the regenerated block describes the new area');
    assert.ok(isNasoHook({ body: await read(dir, '.git/hooks/pre-commit') }), 'NASO\'s hook is reinstalled');
  });
});

test('the overview lists every destination with exact line counts before the only question', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { decisions: ['accept'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const beforeQuestion = res.stdout.slice(0, res.stdout.indexOf('@@{"ask":"decide"'));
    const planned = plannedWrites(beforeQuestion);
    // The toolset is one row in the overview: sixteen lines of .mjs names tell a person
    // deciding nothing that "N files, M lines, the hook runs this copy" does not.
    const vendored = (await readdir(path.join(dir, '.naso', 'tooling'))).map((f) => `.naso/tooling/${f}`);
    assert.equal(vendored.length, (await vendorSources()).length + 1, 'every source, plus VERSION');
    let toolingLines = 0;
    for (const file of vendored) toolingLines += linesIn(await read(dir, file));
    assert.deepEqual(planned.get('.naso/tooling/'), { change: 'new', lines: toolingLines });
    assert.match(beforeQuestion, new RegExp(`\\.naso/tooling/\\s+new, \\d+ lines\\s+\\(${vendored.length} files`));

    for (const [file, row] of planned) {
      if (row.change === 'append' || file.endsWith('/')) continue;
      assert.equal(row.lines, linesIn(await read(dir, file)), `${file}: planned ${row.lines} lines`);
    }
    assert.ok(planned.has(AGENTS) && planned.has('.naso/config.json') && planned.has('.git/hooks/pre-commit'));

    const decide = res.events.find((event) => event.ask === 'decide');
    assert.equal(decide.installsHook, true);
    assert.equal(decide.agents, false, 'nothing may be written before the answer');
    assert.equal(decide.naso, false, 'nothing may be written before the answer');
  });
});

test('"Show details" lists every file one by one and asks again, without counting as a reject', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await driveFlow(dir, { decisions: ['details', 'accept'] });
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const decides = res.events.filter((event) => event.ask === 'decide');
    assert.equal(decides.length, 2);
    assert.equal(decides[1].rejections, 0, 'asking for detail is not a rejection');

    const first = res.stdout.indexOf('@@{"ask":"decide"');
    const between = res.stdout.slice(first, res.stdout.indexOf('@@{"ask":"decide"', first + 1));
    const tooling = [...plannedWrites(between).keys()].filter((p) => p.startsWith('.naso/tooling/') && p !== '.naso/tooling/');
    const vendored = (await readdir(path.join(dir, '.naso', 'tooling'))).map((f) => `.naso/tooling/${f}`);
    assert.deepEqual(tooling.sort(), vendored.sort(), 'the detail is exactly what is copied');
    assert.match(between, /What will change/);
  });
});

test('reject, reject, exit: re-read once, then stop with the tree (.git included) byte-identical', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const res = await driveFlow(dir, { decisions: ['reject', 'reject'], finish: 'exit' });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(await treeHash(dir), before, 'reject-then-exit must leave every byte as it was');
    assert.deepEqual(
      res.events.filter((event) => event.ask).map((event) => [event.ask, event.rejections]),
      [['questions', undefined], ['decide', 0], ['decide', 1], ['afterRejections', undefined]],
    );
    assert.equal(res.stdout.match(/Files this writes/g).length, 2, 'the first reject re-reads and re-plans');
  });
});

test('reject twice, contact support: the report is printed and nothing is written', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const res = await driveFlow(dir, { decisions: ['reject', 'reject'], finish: 'support' });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /--- REPORT ---/);
    assert.match(res.stdout, /contactmrval@gmail\.com/);
    assert.equal(await treeHash(dir), before);
  });
});

test('excluding an area at the question re-plans without counting as a rejection', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/guide.md', '# Guide\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docs');
    const res = await driveFlow(dir, { decisions: ['exclude', 'accept'], area: 'docs' });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const decides = res.events.filter((event) => event.ask === 'decide');
    assert.deepEqual(decides.map((event) => event.rejections), [0, 0]);
    assert.deepEqual(JSON.parse(await read(dir, '.naso/config.json')).exclude, ['docs']);
    assert.ok(!(await read(dir, AGENTS)).includes('`docs/`'));
  });
});

test('cancelling at the accept question leaves the tree byte-identical', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const res = await driveFlow(dir, { decisions: [] });
    assert.equal(res.code, 0);
    assert.equal(await treeHash(dir), before);
  });
});

test('the real accept prompt shows its question and marks the selection', async () => {
  const { PassThrough } = await import('node:stream');
  const { terminalPrompts } = await import(pathToFileURL(path.join(TOOL_DIR, 'flow.mjs')).href);
  const input = new PassThrough();
  const output = new PassThrough();
  let frames = '';
  output.on('data', (chunk) => (frames += chunk));
  const answer = terminalPrompts({ input, output }).decide(plainStyleForTest, { rejections: 0, installsHook: true });
  setTimeout(() => {
    input.write('\u001b[B'); // down: Accept -> Show details
    setTimeout(() => input.write('\r'), 30);
  }, 30);
  assert.equal(await answer, 'details');
  const plain = frames.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  assert.match(plain, /Write these files and install the hook\?/);
  assert.match(plain, /● Accept/, 'the default selection is marked');
  assert.match(plain, /● Show details/, 'moving the selection marks the new choice');
  assert.match(plain, /○ Reject/);
  assert.match(plain, /○ Exclude an area/);
});

test('the real questions ask to replace the NASO block only when there is one', async () => {
  const none = { state: 'none', trackedDir: false, path: '/x/.git/hooks/pre-commit' };
  // track: Enter (No) · hook: Enter (Yes) · replace: y
  const withBlock = await answerRealQuestions({ hook: none, hasBlock: true }, ['\r', '\r', 'y']);
  assert.match(withBlock.frames, /AGENTS\.md already has a NASO block\. Replace it/);
  assert.equal(withBlock.answer.force, true);

  const without = await answerRealQuestions({ hook: none, hasBlock: false }, ['\r', '\r']);
  assert.ok(!/Replace it/.test(without.frames), 'no block, no question');
  assert.equal(without.answer.force, false);
});

test('answering yes to the block question regenerates it; no leaves AGENTS.md byte-identical', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await put(dir, 'docs/guide.md', '# Guide\n');
    await git('add', 'docs/guide.md');
    await git('commit', '-qm', 'docs', '--no-verify');
    const before = await read(dir, AGENTS);

    const kept = await driveFlow(dir, { questions: { force: false }, decisions: ['accept'] });
    // Keeping a block that predates docs/ is allowed, and the verification says it is stale.
    assert.equal(kept.code, 1, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /UNCOVERED \(1\)[\s\S]*- docs\//);
    assert.equal(kept.events[0].hasBlock, true, 'a set-up repository reaches the questions in a terminal');
    assert.equal(await read(dir, AGENTS), before, '"no" must leave the briefing exactly as it was');

    const replaced = await driveFlow(dir, { questions: { force: true }, decisions: ['accept'] });
    assert.equal(replaced.code, 0, replaced.stdout + replaced.stderr);
    assert.match(await read(dir, AGENTS), /`docs\/`/, '"yes" regenerates the block from the repository as it is');
  });
});

test('every label and continuation line on the opening screen shares one value column', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const res = await bare(['--dry-run', '--no-color']);
    const head = res.stdout.slice(0, res.stdout.indexOf('The plan'));
    const lines = head.split('\n');
    const LABEL = /^(What this does|Before you accept|Branch|Files|Areas|Language)( +)\S/;

    const columns = [];
    let inLabelled = false;
    for (const line of lines) {
      const m = line.match(LABEL);
      if (m) {
        columns.push(m[1].length + m[2].length);
        inLabelled = true;
      } else if (inLabelled && /^ +\S/.test(line)) {
        columns.push(line.length - line.trimStart().length);
      } else {
        inLabelled = false;
      }
    }
    assert.ok(columns.length >= 8, `expected labelled lines, got:\n${head}`);
    assert.equal(new Set(columns).size, 1, `values start at columns ${[...new Set(columns)].join(', ')}:\n${head}`);
  });
});

test('deps.interactive is called, so an injected "no terminal" really means no terminal', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const before = await treeHash(dir);
    const driver = `
      const { main } = await import(${JSON.stringify(path.join(TOOL_DIR, 'flow.mjs'))});
      const refuse = async () => { throw new Error('asked a question with no terminal'); };
      main([process.argv[1]], {
        interactive: () => false,
        ask: refuse,
        prompts: { questions: refuse, decide: refuse, pickArea: refuse, afterRejections: refuse, done() {} },
      }).then(() => process.exit(process.exitCode ?? 0), (err) => { console.error(String(err)); process.exit(1); });
    `;
    const res = await exec(process.execPath, ['--input-type=module', '-e', driver, dir], dir);
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.equal(await treeHash(dir), before);
  });
});

test('a tracked AGENTS.md is not put in .git/info/exclude, and the plan says it will show as a change', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Ours\n\nHand-written and committed.\n');
    await git('add', AGENTS);
    await git('commit', '-qm', 'agents');

    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const exclude = await read(dir, '.git/info/exclude');
    assert.ok(!exclude.split('\n').includes('AGENTS.md'), 'excluding a tracked file does nothing and claims otherwise');
    assert.ok(exclude.split('\n').includes('.naso'));
    assert.doesNotMatch(res.stdout, /Kept \.naso and AGENTS\.md out of git/);
    assert.match(res.stdout, /AGENTS\.md is tracked/);
    assert.match((await git('status', '--porcelain')).stdout, /^ M AGENTS\.md$/m);
  });
});

test('an existing AGENTS.md is not listed as a leftover, by setup or by doctor', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Ours\n\nHand-written.\n');
    const res = await bare(['--yes']);
    assert.doesNotMatch(res.stdout, /Leftovers to remove/);
    const doctor = await script('doctor');
    assert.match(doctor.stdout, /Leftover NASO artifacts\s+\S*\s*none/);
  });
});

test('setup links the briefing for Claude Code with a local CLAUDE.md when there is none', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(await read(dir, 'CLAUDE.md'), /^@AGENTS\.md$/m);
    assert.ok((await read(dir, '.git/info/exclude')).split('\n').includes('CLAUDE.md'));
    assert.equal((await git('status', '--porcelain')).stdout, '', 'local mode leaves no trace in git status');
  });
});

test('a tracked CLAUDE.md is not edited in local mode; setup says what to add', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, 'CLAUDE.md', '# Team rules\n');
    await git('add', 'CLAUDE.md');
    await git('commit', '-qm', 'claude');
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(await read(dir, 'CLAUDE.md'), '# Team rules\n');
    assert.match(res.stdout, /add `@AGENTS\.md` to CLAUDE\.md/);
    assert.match((await script('doctor')).stdout, /Claude Code link\s+\S*\s*CLAUDE\.md does not load AGENTS\.md/);
  });
});

test('with --track, a CLAUDE.md that does not load the briefing gets the link appended', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, 'CLAUDE.md', '# Team rules\n');
    await git('add', 'CLAUDE.md');
    await git('commit', '-qm', 'claude');
    assert.equal((await bare(['--yes', '--track'])).code, 0);
    const text = await read(dir, 'CLAUDE.md');
    assert.ok(text.startsWith('# Team rules\n'));
    assert.match(text, /^@AGENTS\.md$/m);
  });
});

test('a CLAUDE.md that already names AGENTS.md is left alone', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, 'CLAUDE.md', 'Read AGENTS.md first.\n');
    const res = await bare(['--yes']);
    assert.equal(await read(dir, 'CLAUDE.md'), 'Read AGENTS.md first.\n');
    assert.doesNotMatch(res.stdout, /add `@AGENTS\.md`/);
    assert.match((await script('doctor')).stdout, /Claude Code link\s+\S*\s*CLAUDE\.md loads AGENTS\.md/);
  });
});

test('setup warns about machine and runtime files that are tracked, and keeps them out of AGENTS.md', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.DS_Store', 'x');
    await put(dir, 'data/task.db', 'x');
    await put(dir, 'src/__pycache__/m.cpython-312.pyc', 'x');
    await git('add', '-A');
    await git('commit', '-qm', 'junk');
    const res = await bare(['--yes']);
    assert.match(res.stdout, /3 machine or runtime files are tracked in git/);
    assert.match(res.stdout, /\.DS_Store/);
    assert.doesNotMatch(await read(dir, AGENTS), /machine or runtime files/);
  });
});
