// Claims a generated briefing made about a real repository that an agent checked against
// the code and found false. Each test is one of those claims, on a fixture shaped like the
// repository it was found in: Expo, TypeScript without "type": "module", GitLab CI, and a
// history of `type: SCRUM-n: summary` subjects.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseGitlabJobs } from '../tooling/briefing.mjs';
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

test('parseGitlabJobs reads list, inline and multi-line scripts and skips templates and keywords', () => {
  const jobs = parseGitlabJobs(GITLAB_CI);
  assert.deepEqual(
    jobs.map((job) => [job.name, job.commands]),
    [
      ['lint', ['npm run lint']],
      ['typecheck', ['npm run typecheck']],
      ['test', ['npm run test -- --ci']],
      ['format', ['npm run format:check']],
      ['api-types', ['npm run api-types']],
    ],
  );
});

test('.gitlab-ci.yml is the gate, and the briefing does not say the repository names none', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.doesNotMatch(text, /names no single gate/);
    assert.match(text, /CI is the gate: `\.gitlab-ci\.yml` runs 5 jobs/);
    assert.match(text, /lint \(`npm run lint`\)/);
    assert.match(text, /api-types \(`npm run api-types`\)/);
    assert.match(text, /includes configuration from outside this repository/);
  });
});

test('a script that rewrites files is not listed as a validation command', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    const commands = text.match(/```bash\n([\s\S]*?)```/)?.[1] ?? '';
    assert.doesNotMatch(commands, /npm run format\n/);
    assert.match(commands, /npm run format:check/);
    assert.match(text, /`npm run format` rewrites files \(`prettier --write \.`\); it is not a check/);
    assert.doesNotMatch(sectionOf(text, 'When Done'), /`npm run format`/);
  });
});

test('the alias line states the mapping and claims no rule NASO never read', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(sectionOf(text, 'Boundaries'), /\*\*Import aliases\.\*\* @ → src\.\n/);
    assert.doesNotMatch(text, /the one mistake/);
  });
});

test('the language mix leaves out AGENTS.md and its total is every file with an extension', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes', '--track'])).code, 0);
    await git('add', '-A');
    await git('commit', '-qm', 'chore: SCRUM-2: briefing');
    assert.equal((await bare(['--yes', '--force', '--track'])).code, 0);
    const text = await read(dir, AGENTS);
    const mix = text.match(/Language mix[^\n]*/)?.[0] ?? '';
    const tracked = (await git('ls-files')).stdout.split('\n').filter(Boolean);
    assert.ok(tracked.includes(AGENTS), 'AGENTS.md is in the index, so leaving it out is a choice');
    const counted = tracked.filter((file) => file !== AGENTS);
    const markdown = counted.filter((file) => file.endsWith('.md')).length;
    assert.match(mix, new RegExp(`Markdown ${markdown}\\b`), mix);
    // .gitignore has no extension by path.extname, so it is the one file not counted.
    const withExtension = counted.filter((file) => path.extname(file) !== '').length;
    assert.match(mix, new RegExp(`of ${withExtension} files with an extension`), mix);
  });
});

test('a TypeScript repository with no "type" field is not called CommonJS throughout', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.doesNotMatch(text, /Modules: CommonJS by default/);
    assert.match(text, /Modules: \.js files are CommonJS \(no "type": "module"\), which covers `eslint\.config\.js`, `metro\.config\.js`; TypeScript source is compiled by its toolchain/);
  });
});

test('Where To Look First names the contributing guide and a folder-structure doc', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(text, /- `CONTRIBUTING\.md` —/);
    assert.match(text, /- `docs\/folder-structure\.md` —/);
    assert.doesNotMatch(text, /- `docs\/release\.md` —/);
  });
});

test('Apple signing files are listed as credentials, not as ignored build output', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const boundaries = sectionOf(await read(dir, AGENTS), 'Boundaries');
    assert.match(boundaries, /\*\*Credentials\.\*\*[^\n]*\*\.p8[^\n]*\*\.mobileprovision/);
    assert.doesNotMatch(boundaries.match(/\*\*Ignored paths\.\*\*[^\n]*/)?.[0] ?? '', /\*\.p8|mobileprovision/);
  });
});

test('the briefing says the hook is local to the machine that ran setup', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    assert.match(
      sectionOf(await read(dir, AGENTS), 'Scope'),
      /The hook runs only where setup installed it[^\n]*CI does not run it/,
    );
  });
});

test('briefing check passes on the customer-app fixture', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedCustomerApp(dir, git, SCRUM_HISTORY);
    assert.equal((await bare(['--yes'])).code, 0);
    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});
