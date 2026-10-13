// Claims a generated briefing made about a real repository that an agent checked against
// the code and found false. Each test is one of those claims, on a fixture shaped like the
// repository it was found in: Expo, TypeScript without "type": "module", GitLab CI, and a
// history of `type: SCRUM-n: summary` subjects.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { parseGitlabJobs, parseWorkflowJobs, diffCheckPaths, extractPathTokens } from '../tooling/briefing.mjs';
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
  await put(dir, 'src/api/schema.d.ts', 'export interface paths {}\n');
  await put(dir, 'openapi.yaml', 'openapi: 3.1.0\n');
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
    assert.match(text, /api-types \(`npm run api-types`, then fails if/);
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

test('a CI job that regenerates a file and diffs it is a check, recorded with the path it guards', () => {
  const api = parseGitlabJobs(GITLAB_CI).find((job) => job.name === 'api-types');
  assert.deepEqual(api.diffChecks, ['src/api/schema.d.ts']);
  const lint = parseGitlabJobs(GITLAB_CI).find((job) => job.name === 'lint');
  assert.deepEqual(lint.diffChecks, []);

  const github = parseWorkflowJobs(
    'jobs:\n  types:\n    steps:\n      - run: npm run gen\n      - run: git diff --exit-code -- src/gen.ts\n',
  );
  assert.deepEqual(github[0].diffChecks, ['src/gen.ts']);
});

test('codegen is run with its diff, never alone, and the generated file is marked do-not-edit', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(text, /api-types \(`npm run api-types`, then fails if `src\/api\/schema\.d\.ts` changed\)/);
    const commands = text.match(/```bash\n([\s\S]*?)```/)?.[1] ?? '';
    assert.match(commands, /^npm run api-types && git diff --exit-code src\/api\/schema\.d\.ts$/m);
    assert.doesNotMatch(commands, /^npm run api-types$/m, 'run alone it rewrites the file and checks nothing');
    assert.match(
      sectionOf(text, 'Boundaries'),
      /\*\*Generated files\.\*\* `src\/api\/schema\.d\.ts` is written by `npm run api-types`; regenerate it, never edit it by hand\. CI fails if it changes\./,
    );
    assert.equal((await script('briefing')).code, 0);
  });
});

test('a codegen script CI does not check is still marked generated, with no CI claim', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'g', scripts: { gen: 'graphql-codegen --output src/gql.ts', lint: 'eslint .' } }));
    await put(dir, 'src/gql.ts', 'export {};\n');
    await put(dir, 'src/missing-output-is-not-claimed.ts', 'export {};\n');
    await git('add', '-A');
    await git('commit', '-qm', 'init');
    assert.equal((await bare(['--yes'])).code, 0);
    const boundaries = sectionOf(await read(dir, AGENTS), 'Boundaries');
    assert.match(boundaries, /\*\*Generated files\.\*\* `src\/gql\.ts` is written by `npm run gen`; regenerate it, never edit it by hand\.\n/);
    assert.doesNotMatch(boundaries, /CI fails/);
  });
});

test('a diff check followed by a shell fallback keeps only its paths', () => {
  assert.deepEqual(
    diffCheckPaths("git diff --exit-code src/api/schema.d.ts || { echo 'schema.d.ts is stale; run npm run api:types'; exit 1; }"),
    ['src/api/schema.d.ts'],
  );
  const jobs = parseGitlabJobs(
    "api:\n  script:\n    - npm run api:types\n    - git diff --exit-code src/api/schema.d.ts || { echo 'stale; run npm run api:types'; exit 1; }\n",
  );
  assert.deepEqual(jobs[0].commands, ['npm run api:types']);
  assert.deepEqual(jobs[0].diffChecks, ['src/api/schema.d.ts']);
});

test('with an unread include:, scripts outside the jobs NASO read are not called "not run by CI"', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    await put(dir, 'package.json', JSON.stringify({ name: 'customer-app', scripts: { lint: 'eslint .', test: 'jest', typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '6.0.3' } }));
    await put(dir, '.gitlab-ci.yml', 'include:\n  - component: example.com/ci/react-native@1.0.0\n\nformat:\n  script:\n    - npx prettier --check .\n');
    await git('add', '-A');
    await git('commit', '-qm', 'chore: SCRUM-3: ci');
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.doesNotMatch(text, /Declared but not run by CI/);
    assert.match(text, /Not in the jobs NASO could read; the included configuration may run them: `npm run lint`/);
  });
});

test('the checker reads paths, not every word in backticks', () => {
  const tokens = extractPathTokens(
    'Run `lint` and `code`; send `X-App-Version`; use `formatMoney`; `.svg` files; see `README.md`, ' +
      '`src/app/(tabs)/`, `src/app/[id].tsx`, `Makefile`, `CODEOWNERS`, `.gitignore`.',
  );
  assert.deepEqual(tokens, ['.gitignore', 'CODEOWNERS', 'Makefile', 'README.md', 'src/app/(tabs)/', 'src/app/[id].tsx']);
});

test('the vendored toolset is invisible to the repository\'s ESLint and Prettier', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    await put(dir, '.prettierrc', '{}\n');
    await put(dir, '.prettierignore', 'coverage/\n');
    await git('add', '-A');
    await git('commit', '-qm', 'chore: SCRUM-4: prettier');
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    for (const file of (await readdir(`${dir}/.naso/tooling`)).filter((f) => f.endsWith('.mjs'))) {
      const head = (await read(dir, `.naso/tooling/${file}`)).split('\n').slice(0, 2).join('\n');
      assert.match(head, /^(?:#!.*\n)?\/\* eslint-disable \*\/ \/\/ vendored by naso-dev/, `${file} must opt out of the repository's lint`);
    }
    assert.equal(await read(dir, '.prettierignore'), 'coverage/\n.naso/\n');
    assert.match(res.stdout, /\.prettierignore\s+append 1 line/);
    // A second run adds nothing.
    assert.equal((await bare(['--yes', '--force'])).code, 0);
    assert.equal(await read(dir, '.prettierignore'), 'coverage/\n.naso/\n');
  });
});

test('no Prettier, no .prettierignore', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await assert.rejects(read(dir, '.prettierignore'));
  });
});

test('the Scope section says what the hook checks, what it does not, and when it lets a commit through', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const scope = sectionOf(await read(dir, AGENTS), 'Scope').replace(/\s+/g, ' ');
    assert.match(scope, /checks staged files for secret-shaped lines, scope, format and lint/);
    assert.match(scope, /does not type-check, run tests or read the commit message/);
    assert.match(scope, /If \.naso\/tooling\/ is missing it prints one line and lets the commit through/);
  });
});

test('a codegen script is named as rewriting the file it generates', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    assert.match(await read(dir, AGENTS), /`npm run api-types` rewrites `src\/api\/schema\.d\.ts`; it is not a check\./);
  });
});

test('a CONTRIBUTING.md that states commit rules is named as the authority over the count', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedCustomerApp(dir, git, SCRUM_HISTORY);
    await put(dir, 'CONTRIBUTING.md', '# Contributing\n\n## Commits\n\nUse `<type>: <KEY>: <summary>`.\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docs: SCRUM-9: commits');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.match(
      sectionOf(await read(dir, AGENTS), 'Commit Standard'),
      /`CONTRIBUTING\.md` writes the commit rules down; where it and this count differ, it wins\./,
    );
  });
});
