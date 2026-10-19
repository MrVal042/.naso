// The repository's own toolchain around NASO's files: its linter must not warn about the
// vendored copy, doctor must say when it does, and the block keeps only lines that change
// what an agent does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BIN, AGENTS, FAKE_ESLINT, exec, withRepo, put, read, seedProject, seedFieldRepo, sectionOf } from './helpers.mjs';

const naso = (dir, args) => exec(process.execPath, [BIN, ...args], dir);

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

test('the Feature To Folder Map lists only folders whose name says what they hold, without file counts', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    for (const feature of ['auth', 'payments', 'profile']) await put(dir, `src/features/${feature}/index.ts`, 'export {};\n');
    await git('add', '-A');
    await git('commit', '-qm', 'features');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.doesNotMatch(await read(dir, AGENTS), /Feature To Folder Map/, 'names and counts only: no table');
  });
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    for (const feature of ['auth', 'components']) await put(dir, `src/features/${feature}/index.ts`, 'export {};\n');
    await git('add', '-A');
    await git('commit', '-qm', 'features');
    assert.equal((await bare(['--yes'])).code, 0);
    const map = sectionOf(await read(dir, AGENTS), 'Feature To Folder Map');
    assert.match(map, /\| Components \| `src\/features\/components\/` \| user interface \|/);
    assert.doesNotMatch(map, /Auth|\d+ files?/);
  });
});

test('a fresh clone gets the hook from one command, named the same in the block, doctor and refresh', async () => {
  const { rm } = await import('node:fs/promises');
  const path = await import('node:path');
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes', '--track'])).code, 0);
    const scope = sectionOf(await read(dir, AGENTS), 'Scope').replace(/\s+/g, ' ');
    assert.match(scope, /a fresh clone has none until someone runs `npx naso-dev refresh` there/);
    assert.doesNotMatch(scope, /until setup runs there/);

    // A teammate's clone: everything tracked is there, the hook is not.
    await rm(path.join(dir, '.git/hooks/pre-commit'));
    const before = { agents: await read(dir, AGENTS), lib: await read(dir, '.naso/tooling/lib.mjs'), config: await read(dir, '.naso/config.json') };
    assert.match((await script('doctor')).stdout, /WARN\s+pre-commit hook\s+missing; install it with `npx naso-dev refresh`/);
    const res = await naso(dir, ['refresh']);
    assert.equal(res.code, 0, res.stdout);
    assert.match(await read(dir, '.git/hooks/pre-commit'), /naso/i);
    assert.deepEqual({ agents: await read(dir, AGENTS), lib: await read(dir, '.naso/tooling/lib.mjs'), config: await read(dir, '.naso/config.json') }, before, 'at the same version nothing else changes');
  });
});

/**
 * Prefix rules from gitleaks' default config, the ones that fire on a single token. A test
 * cannot depend on gitleaks being installed, so these run everywhere; gitleaks itself runs
 * below when it is on PATH or NASO_GITLEAKS names it.
 */
const KEY_SHAPES = [
  ['aws-access-token', /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/],
  ['github-pat', /\bgh[pousr]_[0-9a-zA-Z]{36}\b/],
  ['github-fine-grained-pat', /\bgithub_pat_\w{82}\b/],
  ['gitlab-pat', /\bglpat-[\w-]{20}\b/],
  ['stripe-access-token', /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/],
  ['slack-token', /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/],
  ['private-key', /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{64,}?-----END/],
  ['gcp-api-key', /\bAIza[\w-]{35}\b/],
  ['npm-access-token', /\bnpm_[a-z0-9]{36}\b/i],
  ['anthropic-api-key', /\bsk-ant-(?:api|admin)\d{2}-[\w-]{80,}/],
  ['openai-api-key', /\bsk-(?:proj|svcacct|admin)?-?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/],
];

test('the vendored toolset and the decisions folder hold nothing a secret scanner reports', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { STRIPE_FIXTURE, GITHUB_FIXTURE } = await import('./helpers.mjs');
  const shaped = (text) => KEY_SHAPES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  assert.deepEqual(shaped(`${STRIPE_FIXTURE} ${GITHUB_FIXTURE}`), ['github-pat', 'stripe-access-token'], 'the shapes catch a planted key');

  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal((await naso(dir, ['decide', '--title', 'Tokens live in SecureStore', '--decision', 'Auth tokens live in SecureStore.', '--source', 'kickoff'])).code, 0);
    const found = [];
    for (const folder of ['.naso/tooling', 'docs/decisions']) {
      for (const name of await readdir(path.join(dir, folder))) {
        for (const rule of shaped(await readFile(path.join(dir, folder, name), 'utf8'))) found.push(`${folder}/${name}: ${rule}`);
      }
    }
    assert.deepEqual(found, []);

    const { run } = await import('../tooling/lib.mjs');
    const gitleaks = process.env.NASO_GITLEAKS || ((await run('gitleaks', ['version'], { cwd: dir })).ok ? 'gitleaks' : null);
    if (!gitleaks) return;
    for (const folder of ['.naso', 'docs/decisions']) {
      const res = await exec(gitleaks, ['dir', folder, '--no-banner', '--redact', '--exit-code', '1'], dir);
      assert.equal(res.code, 0, `gitleaks reports ${folder}:\n${res.stdout}${res.stderr}`);
    }
  });
});

test('setup derives the toolchain facts agents had to add by hand, each cited, and the block still passes', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedFieldRepo(dir, git);
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    const conventions = sectionOf(text, 'Code Conventions');
    assert.match(conventions, /Format: Prettier configured by `\.prettierrc`: printWidth 100, singleQuote true, trailingComma "all"; every other option is Prettier's default\./);
    assert.match(conventions, /Jest \(`package\.json` "jest"\): preset `jest-expo`; moduleNameMapper mocks `\\\.svg\$` → `<rootDir>\/__mocks__\/svgMock\.js`\./);
    const stack = sectionOf(text, 'Stack Rules');
    assert.match(stack, /runtimeVersion uses the appVersion policy \(`app\.config\.ts`\): bump `version` there whenever native code changes/);
    assert.match(stack, /Expo experiments on in `app\.config\.ts`: typedRoutes \([^)]*\); reactCompiler \(/);
    assert.match(stack, /`metro\.config\.js` transforms \.svg files with react-native-svg-transformer\/expo: an \.svg import is a React component/);
    assert.match(sectionOf(text, 'Boundaries'), /\*\*Generated by the framework\.\*\* `\.expo\/` and `expo-env\.d\.ts` are written by Expo[^\n]*git-ignored: never edit or commit them\. tsconfig\.json includes \.expo\/, expo-env\.d\.ts as a pattern, so type-checking runs without them on a fresh clone/);
    const checklist = sectionOf(text, 'Merge Request Checklist');
    assert.match(checklist, /- `\.gitlab\/merge_request_templates\/Default\.md` line 3: “Tests added or updated”/);
    assert.match(checklist, /line 5: “No secret in an EXPO_PUBLIC_ variable”/);
    const commits = sectionOf(text, 'Commit Standard');
    assert.match(commits, /Exception: `CONTRIBUTING\.md` line 8: “Revert messages are accepted as git writes them\.”/);
    assert.match(commits, /Merging: `CONTRIBUTING\.md` line 12: “Merge requests are squashed when they merge\.”/);
    assert.match(commits, /Approval: `CONTRIBUTING\.md` line 13: “Code owners may self-approve documentation changes\.”/);
    const check = await script('briefing');
    assert.doesNotMatch(check.stdout, /WRONG|MISSING|UNCOVERED/, check.stdout);
    // A decision written outside a table is a candidate too.
    assert.match((await naso(dir, ['review'])).stdout, /app\.config\.ts line 3: decided 2026-03-02: the app is portrait only/);
  });
});
