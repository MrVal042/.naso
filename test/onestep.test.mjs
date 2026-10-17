// One command: `npx naso-dev` sets up the repository and, when asked, records naso-dev as a
// dev dependency with the repository's own package manager. A fake package manager on PATH
// records what it was asked to run, so no test touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { devDependencyPlan } from '../tooling/setup.mjs';
import { toolVersion } from '../tooling/lib.mjs';
import { BIN, exec, withRepo, put, read, exists, seedProject, driveFlow } from './helpers.mjs';

/**
 * A fake `npm` that appends its arguments to npm-calls.log and, unless told to lie, moves
 * naso-dev into devDependencies the way the real one does.
 */
async function fakeNpm(dir, { edits = true } = {}) {
  const bin = path.join(dir, '.fake-bin');
  const edit = edits
    ? `${JSON.stringify(process.execPath)} -e "const f='package.json',fs=require('fs'),p=JSON.parse(fs.readFileSync(f));` +
      `if(p.dependencies)delete p.dependencies['naso-dev'];p.devDependencies={...p.devDependencies,'naso-dev':'^0'};fs.writeFileSync(f,JSON.stringify(p))"\n`
    : '';
  await put(bin, 'npm', `#!/bin/sh\necho "$@" >> "${path.join(dir, '.fake-bin', 'npm-calls.log')}"\n${edit}exit 0\n`);
  await chmod(path.join(bin, 'npm'), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

test('devDependencyPlan adds, moves, or leaves naso-dev, per package manager', () => {
  assert.equal(devDependencyPlan(null, 'npm', '1.2.0'), null, 'no package.json, nothing to record');
  assert.equal(devDependencyPlan({ devDependencies: { 'naso-dev': '^1.0.0' } }, 'npm', '1.2.0').action, 'present');

  const add = devDependencyPlan({ name: 'x' }, 'npm', '1.2.0');
  assert.equal(add.action, 'add');
  assert.deepEqual(add.commands, [['npm', ['install', '--save-dev', 'naso-dev@1.2.0']]]);

  const move = devDependencyPlan({ dependencies: { 'naso-dev': '^1.1.3' } }, 'npm', '1.2.0');
  assert.equal(move.action, 'move');
  assert.deepEqual(move.commands, [['npm', ['install', '--save-dev', 'naso-dev@1.2.0']]]);

  assert.deepEqual(devDependencyPlan({}, 'pnpm', '1.2.0').commands, [['pnpm', ['add', '--save-dev', 'naso-dev@1.2.0']]]);
  assert.deepEqual(devDependencyPlan({}, 'yarn', '1.2.0').commands, [['yarn', ['add', '--dev', 'naso-dev@1.2.0']]]);
  assert.deepEqual(devDependencyPlan({}, 'bun', '1.2.0').commands, [['bun', ['add', '--dev', 'naso-dev@1.2.0']]]);
  // yarn and bun leave a package in dependencies when asked to add it as dev; it is removed first.
  assert.deepEqual(devDependencyPlan({ dependencies: { 'naso-dev': '1' } }, 'yarn', '1.2.0').commands, [
    ['yarn', ['remove', 'naso-dev']],
    ['yarn', ['add', '--dev', 'naso-dev@1.2.0']],
  ]);
});

test('--yes --save-dev records naso-dev with the package manager, after everything else is written', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const env = await fakeNpm(dir);
    const res = await exec(process.execPath, [BIN, dir, '--yes', '--save-dev'], dir, env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const calls = await read(dir, '.fake-bin/npm-calls.log');
    assert.equal(calls.trim(), `install --save-dev naso-dev@${await toolVersion()}`);
    assert.match(res.stdout, /devDependencies: added naso-dev with `npm install --save-dev naso-dev@/);
    assert.ok(await exists(dir, 'AGENTS.md'));
  });
});

test('--yes alone never runs the package manager: a script gets no network unless it asks', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const env = await fakeNpm(dir);
    const res = await exec(process.execPath, [BIN, dir, '--yes'], dir, env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(await exists(dir, '.fake-bin/npm-calls.log'), false);
  });
});

test('naso-dev in dependencies is shown in the plan as a move to devDependencies', async () => {
  await withRepo(async ({ dir, git }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'demo', dependencies: { 'naso-dev': '^1.1.3' } }));
    await put(dir, 'src/a.ts', 'export const a = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'init');
    const env = await fakeNpm(dir);
    const res = await exec(process.execPath, [BIN, dir, '--dry-run', '--save-dev'], dir, env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Move\s+naso-dev to devDependencies/);
    assert.match(res.stdout, /where a production install and the app's build\s+pick it up/);
    assert.equal(await exists(dir, '.fake-bin/npm-calls.log'), false, '--dry-run runs nothing');
  });
});

test('the flow asks about the dev dependency only when there is something to record', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const env = await fakeNpm(dir);
    const { events } = await driveFlow(dir, { questions: { saveDev: false }, decisions: ['accept'] });
    assert.equal(events.find((event) => event.ask === 'questions').dev, 'add');
    assert.equal(await exists(dir, '.fake-bin/npm-calls.log'), false);
    void env;
  });
  await withRepo(async ({ dir, git }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'demo', devDependencies: { 'naso-dev': '^1.0.0' } }));
    await git('add', '-A');
    await git('commit', '-qm', 'init');
    const { events } = await driveFlow(dir, { questions: {}, decisions: ['accept'] });
    assert.equal(events.find((event) => event.ask === 'questions').dev, 'present');
  });
});

test('the agent prompt asks for a checked correction inside the markers, not only a reading', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const res = await bare(['--yes']);
    const prompt = res.stdout.slice(res.stdout.indexOf('## Last step: hand this to your coding agent'));
    assert.doesNotMatch(prompt, /Do not propose changes to AGENTS\.md yet/);
    assert.match(prompt, /CONTRIBUTING/);
    assert.match(prompt, /only between <!-- naso:start --> and <!-- naso:end -->/);
    assert.match(prompt, /npx naso-dev briefing/);
    assert.match(prompt, /never open or print/i);
    assert.match(prompt, /Do not commit/);
  });
});

test('setup ends by saying what the repository now has, from what was actually done', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const res = await bare(['--yes']);
    const end = res.stdout.slice(res.stdout.indexOf('## What you have now'), res.stdout.indexOf('## Last step'));
    assert.ok(res.stdout.includes('## What you have now'), res.stdout);
    assert.match(end, /path claims? checked against this repository/);
    assert.match(end, /Claude Code loads it through CLAUDE\.md/);
    assert.match(end, /Every commit on this machine/);
    assert.match(end, /Nothing reached git history/);
    assert.doesNotMatch(end, /devDependencies/);
  });
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const end = ((await bare(['--yes', '--no-hook', '--track'])).stdout.split('## What you have now')[1] ?? '').split('## Last step')[0];
    assert.doesNotMatch(end, /Every commit on this machine/);
    assert.match(end, /No pre-commit gate/);
    assert.match(end, /Commit AGENTS\.md and \.naso\/ and every teammate/);
  });
});

test('a package manager that exits 0 without recording naso-dev is reported, not believed', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const env = await fakeNpm(dir, { edits: false });
    const res = await exec(process.execPath, [BIN, dir, '--yes', '--save-dev'], dir, env);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /devDependencies: could not record naso-dev/);
    assert.match(res.stdout, /package\.json has no devDependencies entry/);
    assert.doesNotMatch((res.stdout.split('## What you have now')[1] ?? '').split('## Last step')[0], /devDependencies/);
  });
});

test('the real prompt asks the dev dependency question last, defaulting to yes', async () => {
  const { answerRealQuestions } = await import('./helpers.mjs');
  const none = { state: 'none', trackedDir: false };
  const add = await answerRealQuestions({ hook: none, hasBlock: false, devDependency: { action: 'add', pm: 'pnpm' } }, ['\r', '\r', '\r']);
  assert.match(add.frames, /Add naso-dev to devDependencies with pnpm/);
  assert.equal(add.answer.saveDev, true);

  const move = await answerRealQuestions({ hook: none, hasBlock: false, devDependency: { action: 'move', pm: 'npm' } }, ['\r', '\r', 'n']);
  assert.match(move.frames, /naso-dev is in dependencies, where production installs pick it up/);
  assert.equal(move.answer.saveDev, false);

  const present = await answerRealQuestions({ hook: none, hasBlock: false, devDependency: { action: 'present', commands: [] } }, ['\r', '\r']);
  assert.doesNotMatch(present.frames, /devDependencies/);
});

test('setup finishes on the agent prompt, with short commands and no plan repeated', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const out = res.stdout.trimEnd();
    assert.ok(out.endsWith('--------------------------------------------------------------'), 'the prompt is the last thing printed');
    assert.ok(out.indexOf('## What you have now') < out.indexOf('## Last step: hand this to your coding agent'));

    const written = out.slice(out.indexOf('## Accepted — writing'));
    assert.match(written, /✓ AGENTS\.md: wrote the NASO block/);
    assert.equal((written.match(/`src\/` — /g) ?? []).length, 0, 'the areas were in the plan; they are not printed twice');
    // Run from inside the repository, a command needs no path to be pasted back.
    assert.match(written, /^ {2}npx naso-dev doctor\s{2,}/m);
    assert.doesNotMatch(written, new RegExp(`npx naso-dev doctor ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});
