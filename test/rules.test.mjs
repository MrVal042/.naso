// Rules the repository's people already wrote down — owners, precedence, branch names, the
// folder map — read from their files and cited, in any kind of repository.

import test from 'node:test';
import assert from 'node:assert/strict';
import { documentedBranchPattern } from '../tooling/lib.mjs';
import { AGENTS, withRepo, put, read, sectionOf, exec } from './helpers.mjs';

async function seed(dir, git, files) {
  for (const [name, text] of Object.entries(files)) await put(dir, name, text);
  await git('add', '-A');
  await git('commit', '-qm', 'init');
}

async function briefingOf(files) {
  let text = '';
  await withRepo(async ({ dir, git, bare, script }) => {
    await seed(dir, git, files);
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const check = await script('briefing');
    assert.equal(check.code, 0, `every path claimed must exist:\n${check.stdout}${check.stderr}`);
    text = await read(dir, AGENTS);
  });
  return text;
}

const base = { 'package.json': JSON.stringify({ name: 'svc', scripts: { lint: 'eslint .' } }), 'src/index.ts': 'export {};\n' };

test('CODEOWNERS paths are listed with their owners, and a pattern nothing matches is named', async () => {
  const text = await briefingOf({
    ...base,
    '.github/CODEOWNERS': '# owners\n*       @team/core\n/.github/workflows/  @alice\n/src/payments/  @bob @carol\n/infra/terraform/ @ops\n',
    'src/payments/charge.ts': 'export {};\n',
    '.github/workflows/ci.yml': 'jobs:\n  ci:\n    steps:\n      - run: npm run lint\n',
  });
  const owners = sectionOf(text, 'Boundaries').match(/\*\*Owners\.\*\*[^\n]*/)?.[0] ?? '';
  assert.match(owners, /`\.github\/CODEOWNERS` asks for these reviewers: \/\.github\/workflows\/ → @alice; \/src\/payments\/ → @bob, @carol; \/infra\/terraform\/ → @ops; everything else → @team\/core\./);
  assert.match(owners, /\/infra\/terraform\/ matches no tracked file yet\./);
});

test('no CODEOWNERS, no Owners line', async () => {
  assert.doesNotMatch(await briefingOf(base), /\*\*Owners\.\*\*/);
});

test('which document wins: the default, plus every line the repository wrote about it, cited', async () => {
  const text = await briefingOf({
    ...base,
    'CLAUDE.md': '# Rules\n\nThe engineering standards win over everything in this repository, including this file.\n\n@AGENTS.md\n',
    'CONTRIBUTING.md': '# Contributing\n\nIf this file and the README disagree, this file wins.\n',
  });
  const wins = sectionOf(text, 'Which Document Wins');
  assert.match(wins, /Where this block and a file people wrote disagree, the file wins/);
  assert.match(wins, /`CLAUDE\.md` line 3: “The engineering standards win over everything in this repository, including this file\.”/);
  assert.match(wins, /`CONTRIBUTING\.md` line 3: “If this file and the README disagree, this file wins\.”/);
});

test('a repository with no precedence lines still gets the one-line default', async () => {
  const wins = sectionOf(await briefingOf(base), 'Which Document Wins');
  assert.match(wins, /Where this block and a file people wrote disagree, the file wins/);
  assert.doesNotMatch(wins, /line \d+:/);
});

test('a generated file names the source it is generated from', async () => {
  const text = await briefingOf({
    'package.json': JSON.stringify({ name: 'app', scripts: { 'api:types': 'openapi-typescript openapi.yaml -o src/api/schema.d.ts' } }),
    'openapi.yaml': 'openapi: 3.1.0\n',
    'src/api/schema.d.ts': 'export interface paths {}\n',
  });
  assert.match(
    sectionOf(text, 'Boundaries'),
    /`src\/api\/schema\.d\.ts` is written by `npm run api:types` from `openapi\.yaml`; regenerate it, never edit it by hand\./,
  );
});

test('documentedBranchPattern turns a written convention into a check', async () => {
  await withRepo(async ({ dir }) => {
    await put(dir, 'CONTRIBUTING.md', '## Branches\n\nName branches `<type>/<KEY>-<n>-<slug>`, e.g. `feat/ABC-12-login`.\n');
    const found = await documentedBranchPattern(dir);
    assert.equal(found.source, 'CONTRIBUTING.md');
    assert.equal(found.text, '<type>/<KEY>-<n>-<slug>');
    assert.ok(found.regex.test('feat/ABC-12-login'));
    assert.ok(found.regex.test('chore/SCRUM-51-bootstrap'));
    assert.ok(!found.regex.test('my-branch'));
    assert.ok(!found.regex.test('feat/login'));
  }, { seed: false });
  await withRepo(async ({ dir }) => {
    await put(dir, 'CONTRIBUTING.md', '# Contributing\n\nOpen a pull request.\n');
    assert.equal(await documentedBranchPattern(dir), null);
  }, { seed: false });
});

test('the briefing states the documented branch pattern and the gate checks it', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seed(dir, git, { ...base, 'CONTRIBUTING.md': '## Branches\n\nName branches `<type>/<KEY>-<n>-<slug>`.\n' });
    assert.equal((await bare(['--yes'])).code, 0);
    assert.match(sectionOf(await read(dir, AGENTS), 'Commit Standard'), /Branch names follow `<type>\/<KEY>-<n>-<slug>` \(`CONTRIBUTING\.md`\)/);

    await git('checkout', '-qb', 'feat/login');
    const res = await exec(process.execPath, [`${dir}/.naso/tooling/validate.mjs`, dir, '--staged', '--no-append'], dir);
    assert.match(res.stdout, /Branch naming.*feat\/login does not follow <type>\/<KEY>-<n>-<slug> \(CONTRIBUTING\.md\)/);
  });
});

test('the source map covers every folder in the source root, with purposes from the docs and stale names flagged', async () => {
  const text = await briefingOf({
    'package.json': JSON.stringify({ name: 'app' }),
    'src/api/client.ts': 'export {};\n',
    'src/api/queries.ts': 'export {};\n',
    'src/auth/session.ts': 'export {};\n',
    'src/features/auth/use-sign-in.ts': 'export {};\n',
    'src/features/home/use-home.ts': 'export {};\n',
    'src/lib/money.ts': 'export {};\n',
    'src/theme/tokens.ts': 'export {};\n',
    'docs/folder-structure.md': [
      '# Folder structure',
      '',
      '- `src/api/` — the HTTP client and generated types',
      '- `src/auth/` — session, tokens and the app lock',
      '- `src/features/` — one folder per feature, screen hooks only',
      '- `src/lib/` — pure helpers, no I/O',
      '- `src/store/` — app-wide state',
      '',
    ].join('\n'),
  });
  const map = sectionOf(text, 'Source Map');
  assert.match(map, /^\| `src\/api\/` \| 2 files \| the HTTP client and generated types \(`docs\/folder-structure\.md`\) \|$/m);
  assert.match(map, /^\| `src\/auth\/` \| 1 file \| session, tokens and the app lock \(`docs\/folder-structure\.md`\) \|$/m);
  assert.match(map, /^\| `src\/theme\/` \| 1 file \| no doc describes it \|$/m);
  assert.match(map, /Two folders share a name: `src\/auth\/` and `src\/features\/auth\/`\./);
  assert.match(map, /`docs\/folder-structure\.md` names src\/store\/, which is not in the repository\./);
});
