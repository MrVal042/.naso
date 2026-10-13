// Claims a generated briefing made about a real repository that an agent checked against
// the code and found false. Each test is one of those claims, on a fixture shaped like the
// repository it was found in: Expo, TypeScript without "type": "module", GitLab CI, and a
// history of `type: SCRUM-n: summary` subjects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, withRepo, put, read, sectionOf } from './helpers.mjs';

const GITLAB_CI = `include:
  - project: platform/ci-templates
    file: baseline.yml

stages:
  - check

variables:
  NODE_VERSION: "22"

.node:
  image: node:22
  before_script:
    - npm ci

lint:
  extends: .node
  stage: check
  script:
    - npm run lint

typecheck:
  extends: .node
  stage: check
  script: npm run typecheck

test:
  extends: .node
  stage: check
  script:
    - npm run test -- --ci

format:
  extends: .node
  stage: check
  script:
    - npm run format:check

api-types:
  extends: .node
  stage: check
  script:
    - npm run api-types
    - git diff --exit-code src/api/schema.d.ts
`;

async function seedCustomerApp(dir, git, subjects = []) {
  await put(
    dir,
    'package.json',
    JSON.stringify({
      name: 'customer-app',
      main: 'expo-router/entry',
      scripts: {
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        test: 'jest',
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
        'api-types': 'openapi-typescript openapi.yaml -o src/api/schema.d.ts',
      },
      dependencies: { expo: '~57.0.0', 'expo-router': '~6.0.0' },
      devDependencies: { typescript: '6.0.3', jest: '^30.0.0' },
    }),
  );
  await put(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, paths: { '@/*': ['./src/*'] } } }));
  await put(dir, 'eslint.config.js', 'module.exports = [];\n');
  await put(dir, 'metro.config.js', 'module.exports = {};\n');
  await put(dir, '.gitlab-ci.yml', GITLAB_CI);
  await put(dir, 'README.md', '# Erad\n');
  await put(dir, 'CONTRIBUTING.md', '# Contributing\n');
  await put(dir, 'docs/folder-structure.md', '# Folders\n');
  await put(dir, 'docs/release.md', '# Release\n');
  await put(dir, 'src/app/_layout.tsx', 'export default function Layout() { return null; }\n');
  await put(dir, 'src/api/client.ts', 'export const client = 1;\n');
  await put(dir, 'src/api/client.test.ts', "test('x', () => {});\n");
  await put(dir, '.gitignore', 'node_modules/\n/ios\n/android\n*.p8\n*.mobileprovision\n.env*\n');
  await git('add', '-A');
  await git('commit', '-qm', 'chore: SCRUM-1: bootstrap');
  for (const [i, subject] of subjects.entries()) {
    await put(dir, `src/f${i}.ts`, `export const v${i} = ${i};\n`);
    await git('add', '-A');
    await git('commit', '-qm', subject);
  }
}

const SCRUM_HISTORY = [
  'feat: SCRUM-12: sign-up screen',
  'fix: SCRUM-14: keep the KYC draft on resume',
  'chore: SCRUM-15: bump expo',
  'feat: SCRUM-18: wallet card',
  'test: SCRUM-19: session lock',
  'docs: SCRUM-20: release notes',
];

test('a ticket-keyed history is stated as `type: KEY-n: summary`, not `type(scope): summary`', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git, SCRUM_HISTORY);
    assert.equal((await bare(['--yes'])).code, 0);
    const commits = sectionOf(await read(dir, AGENTS), 'Commit Standard');
    assert.doesNotMatch(commits, /type\(scope\)/);
    assert.match(commits, /`type: SCRUM-n: summary`/);
    assert.match(commits, /non-merge commits/);
  });
});

test('a history that rarely uses a scope is not told to add one', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git, ['feat: a', 'fix(api): b', 'fix: c', 'docs: d', 'chore: e', 'test: f']);
    assert.equal((await bare(['--yes'])).code, 0);
    const commits = sectionOf(await read(dir, AGENTS), 'Commit Standard');
    assert.match(commits, /`type: summary`/);
    assert.doesNotMatch(commits, /follow `type\(scope\): summary`/);
  });
});
