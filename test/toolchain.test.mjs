// The repository's own toolchain around NASO's files: its linter must not warn about the
// vendored copy, doctor must say when it does, and the block keeps only lines that change
// what an agent does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BIN, AGENTS, exec, withRepo, put, read, seedProject, sectionOf } from './helpers.mjs';

const naso = (dir, args) => exec(process.execPath, [BIN, ...args], dir);

/**
 * A stand-in for the repository's ESLint, at the path a real install puts it. It prints what
 * ESLint 9 prints for a vendored file's unused disable directive, unless the flat config or
 * .eslintignore names .naso/. NASO's tests install no dependency, so this is the linter.
 */
const FAKE_ESLINT = `
const fs = require('node:fs');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const config = ['eslint.config.js', 'eslint.config.mjs'].map(read).join('') + read('.eslintignore');
if (process.argv.slice(2).some((arg) => arg.startsWith('.naso')) && !config.includes('.naso')) {
  console.log(process.cwd() + '/.naso/tooling/lib.mjs');
  console.log('  1:1  warning  Unused eslint-disable directive (no problems were reported)');
  console.log('');
  console.log('✖ 1 problem (0 errors, 1 warning)');
}
`;

async function seedEslint(dir, git, config, name = 'eslint.config.js') {
  await seedProject(dir, git);
  await put(dir, '.gitignore', 'node_modules/\n');
  await put(dir, name, config);
  await put(dir, 'node_modules/eslint/bin/eslint.js', FAKE_ESLINT);
  await git('add', '-A');
  await git('commit', '-qm', 'eslint');
}

test('setup adds .naso/ to a flat ESLint config\'s ignores, in the config\'s own quote style', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedEslint(dir, git, 'const expo = require("eslint-config-expo/flat");\n\nmodule.exports = [\n  ...expo,\n  { ignores: ["dist/*"] },\n];\n');
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /eslint\.config\.js\s+insert 2 lines/);
    assert.equal(
      await read(dir, 'eslint.config.js'),
      'const expo = require("eslint-config-expo/flat");\n\nmodule.exports = [\n  // Vendored by naso-dev; not part of this project\'s code\n  { ignores: [".naso/"] },\n  ...expo,\n  { ignores: ["dist/*"] },\n];\n',
    );
    assert.doesNotMatch((await naso(dir, ['review'])).stdout, /does not ignore \.naso\//);
    // A second run adds nothing.
    assert.equal((await bare(['--yes', '--force'])).code, 0);
    assert.equal(((await read(dir, 'eslint.config.js')).match(/\.naso\//g) ?? []).length, 1);
  });
});

test('setup places the ignore in defineConfig, tseslint.config and a named export', async () => {
  const { eslintIgnoreEdit } = await import('../tooling/setup.mjs');
  assert.match(eslintIgnoreEdit("import { defineConfig } from 'eslint/config';\n\nexport default defineConfig([\n  js.configs.recommended,\n]);\n"), /defineConfig\(\[\n  \/\/ Vendored[^\n]*\n  \{ ignores: \['\.naso\/'\] \},\n  js\.configs/);
  assert.match(eslintIgnoreEdit("export default tseslint.config(\n  eslint.configs.recommended,\n);\n"), /tseslint\.config\(\n  \/\/ Vendored[^\n]*\n  \{ ignores: \['\.naso\/'\] \},\n  eslint\.configs/);
  assert.match(eslintIgnoreEdit("const config = [\n\tjs.configs.recommended,\n];\n\nexport default config;\n"), /const config = \[\n\t\/\/ Vendored[^\n]*\n\t\{ ignores: \['\.naso\/'\] \},\n\tjs/);
  assert.equal(eslintIgnoreEdit('export default makeConfig();\n'), null, 'no array to place it in: nothing is guessed');
});

test('a legacy ESLint config gets .naso/ in .eslintignore; --no-ignore-files opts out of every ignore edit', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedEslint(dir, git, '{ "extends": "eslint:recommended" }\n', '.eslintrc.json');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal(await read(dir, '.eslintignore'), "# Vendored by naso-dev; not part of this project's code\n.naso/\n");
  });
  await withRepo(async ({ dir, git, bare }) => {
    await seedEslint(dir, git, 'export default [\n  { rules: {} },\n];\n', 'eslint.config.mjs');
    await put(dir, '.prettierrc', '{}\n');
    await git('add', '-A');
    await git('commit', '-qm', 'prettier');
    const res = await bare(['--yes', '--no-ignore-files']);
    assert.equal(res.code, 0, res.stdout);
    assert.equal(await read(dir, 'eslint.config.mjs'), 'export default [\n  { rules: {} },\n];\n');
    await assert.rejects(read(dir, '.prettierignore'));
    assert.match((await naso(dir, ['review'])).stdout, /eslint\.config\.mjs does not ignore \.naso\//);
  });
});

test('doctor runs the repository\'s ESLint on .naso/ and reports what it prints', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedEslint(dir, git, 'export default [\n  { rules: {} },\n];\n', 'eslint.config.mjs');
    assert.equal((await bare(['--yes', '--no-ignore-files'])).code, 0);
    let doctor = await script('doctor');
    assert.match(doctor.stdout, /WARN\s+ESLint on \.naso\/\s+prints 4 lines: [^\n]*\.naso\/tooling\/lib\.mjs/);
    assert.match(doctor.stdout, /Unused eslint-disable directive/);
    assert.equal((await bare(['--yes', '--force'])).code, 0);
    doctor = await script('doctor');
    assert.match(doctor.stdout, /OK\s+ESLint on \.naso\/\s+prints nothing/);
  });
});
