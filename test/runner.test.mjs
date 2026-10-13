// Every command NASO prints for the person to run uses the package manager this repository
// uses, and the form that works whether or not naso-dev is installed here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { nasoCommand, nasoUpgradeCommand, setNasoTarget } from '../tooling/lib.mjs';
import { BIN, exec, withRepo, put, read } from './helpers.mjs';

const at = async (dir, files, agent = '') => {
  for (const [name, text] of Object.entries(files)) await put(dir, name, text);
  setNasoTarget(dir);
  const saved = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = agent;
  try {
    return { run: nasoCommand(), latest: nasoCommand({ version: 'latest' }), upgrade: nasoUpgradeCommand() };
  } finally {
    if (saved === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = saved;
  }
};

const pkg = (extra = {}) => JSON.stringify({ name: 'x', ...extra });
const installed = { devDependencies: { 'naso-dev': '^1.2.0' } };

test('nasoCommand follows the repository package manager and whether naso-dev is installed', async () => {
  const cases = [
    [{ 'package.json': pkg(), 'package-lock.json': '{}' }, '', 'npx naso-dev', 'npx naso-dev@latest', 'npm install --save-dev naso-dev@latest'],
    [{ 'package.json': pkg(), 'pnpm-lock.yaml': '' }, '', 'pnpm dlx naso-dev', 'pnpm dlx naso-dev@latest', 'pnpm add --save-dev naso-dev@latest'],
    [{ 'package.json': pkg(installed), 'pnpm-lock.yaml': '' }, '', 'pnpm exec naso-dev', 'pnpm dlx naso-dev@latest', 'pnpm add --save-dev naso-dev@latest'],
    [{ 'package.json': pkg(), 'bun.lock': '' }, '', 'bunx naso-dev', 'bunx naso-dev@latest', 'bun add --dev naso-dev@latest'],
    [{ 'package.json': pkg(installed), 'yarn.lock': '' }, '', 'yarn naso-dev', 'npx naso-dev@latest', 'yarn add --dev naso-dev@latest'],
    [{ 'package.json': pkg(), 'yarn.lock': '' }, '', 'npx naso-dev', 'npx naso-dev@latest', 'yarn add --dev naso-dev@latest'],
    [{ 'package.json': pkg(), 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' }, '', 'yarn dlx naso-dev', 'yarn dlx naso-dev@latest', 'yarn add --dev naso-dev@latest'],
    [{ 'package.json': pkg({ packageManager: 'pnpm@9.12.0' }) }, '', 'pnpm dlx naso-dev', 'pnpm dlx naso-dev@latest', 'pnpm add --save-dev naso-dev@latest'],
    // Nothing in the repository says; the manager that launched NASO does.
    [{ 'README.md': '# x\n' }, 'pnpm/9.12.0 npm/? node/v22.0.0 darwin arm64', 'pnpm dlx naso-dev', 'pnpm dlx naso-dev@latest', 'pnpm add --save-dev naso-dev@latest'],
    [{ 'README.md': '# x\n' }, 'bun/1.1.0 npm/? node/v22.0.0', 'bunx naso-dev', 'bunx naso-dev@latest', 'bun add --dev naso-dev@latest'],
    [{ 'README.md': '# x\n' }, '', 'npx naso-dev', 'npx naso-dev@latest', 'npm install --save-dev naso-dev@latest'],
  ];
  for (const [files, agent, run, latest, upgrade] of cases) {
    await withRepo(async ({ dir }) => {
      const got = await at(dir, files, agent);
      assert.deepEqual(got, { run, latest, upgrade }, JSON.stringify({ files: Object.keys(files), agent }));
    }, { seed: false });
  }
  setNasoTarget(null);
});

/** A fake pnpm that records naso-dev in devDependencies, as the real one does. */
async function fakePnpm(dir) {
  const bin = path.join(dir, '.fake-bin');
  await put(
    bin,
    'pnpm',
    `#!/bin/sh\n${JSON.stringify(process.execPath)} -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json'));` +
      `p.devDependencies={...p.devDependencies,'naso-dev':'^0'};fs.writeFileSync('package.json',JSON.stringify(p))"\n`,
  );
  await chmod(path.join(bin, 'pnpm'), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, npm_config_user_agent: '' };
}

test('a pnpm repository is never told to run npx, before or after naso-dev is recorded', async () => {
  await withRepo(async ({ dir, git }) => {
    await put(dir, 'package.json', pkg({ scripts: { lint: 'eslint .' } }));
    await put(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put(dir, 'src/a.ts', 'export const a = 1;\n');
    await git('add', '-A');
    await git('commit', '-qm', 'init');
    const env = await fakePnpm(dir);

    const plain = await exec(process.execPath, [BIN, dir, '--yes'], dir, env);
    assert.equal(plain.code, 0, plain.stdout + plain.stderr);
    assert.doesNotMatch(plain.stdout, /npx naso-dev/);
    assert.match(plain.stdout, /^ {2}pnpm dlx naso-dev doctor/m);
    assert.match(plain.stdout, /Run `pnpm dlx naso-dev briefing` and fix anything it reports/);
    assert.match(await read(dir, '.git/hooks/pre-commit'), /Run: pnpm dlx naso-dev refresh/);

    const recorded = await exec(process.execPath, [BIN, dir, '--yes', '--force', '--save-dev'], dir, env);
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
    assert.match(recorded.stdout, /devDependencies: added naso-dev with `pnpm add --save-dev naso-dev@/);
    const after = recorded.stdout.slice(recorded.stdout.indexOf('## What you have now'));
    assert.match(after, /^ {2}pnpm exec naso-dev doctor/m, 'once installed, the installed form');
    assert.doesNotMatch(recorded.stdout, /npx naso-dev/);
  });
});
