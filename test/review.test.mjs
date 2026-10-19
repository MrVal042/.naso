// The review prompt, and the decision record that lets a new session start where the last
// one ended. The prompt is built from the repository as it is now, so a second review
// picks up where the first stopped; a decision is recorded once, with what was turned down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from '../tooling/lib.mjs';
import { ruleSources } from '../tooling/review.mjs';
import { blockEdited } from '../tooling/scan.mjs';
import { BIN, AGENTS, exec, withRepo, put, read, exists, seedProject, sectionOf } from './helpers.mjs';

const naso = (dir, args) => exec(process.execPath, [BIN, ...args], dir);

test('a command can take a value for an option another command uses as a switch', () => {
  assert.ok(parseArgs(['--why']).flags.has('why'));
  const { values, positional } = parseArgs(['--why', 'one contract for every client'], { valued: ['why'] });
  assert.equal(values.get('why'), 'one contract for every client');
  assert.deepEqual(positional, []);
});

test('decide --why records the reason, and never treats it as the target directory', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await naso(dir, [
      'decide', '--title', 'REST only', '--decision', 'The API is REST only.', '--source', 'docs/architecture.md line 3',
      '--why', 'One contract for every client', '--considered', 'GraphQL — no team owns a schema',
    ]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const record = await read(dir, 'docs/decisions/0001-rest-only.md');
    assert.match(record, /## Why\n\nOne contract for every client\n/);
    assert.match(record, /## Considered and not chosen\n\n- GraphQL — no team owns a schema\n/);
    assert.equal(await exists(dir, 'One contract for every client'), false, 'no folder named after the reason');
  });
});

test('decide refuses a target that does not exist instead of creating it', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await naso(dir, ['decide', 'no-such-dir', '--title', 'T', '--decision', 'D', '--source', 'S']);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /target directory does not exist/);
    assert.equal(await exists(dir, 'no-such-dir'), false);
  });
});

test('decide says it once: a recorded title is refused unless the new record supersedes it', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);
    const again = await naso(dir, ['decide', '--title', 'use rest', '--decision', 'REST.', '--source', 'standup']);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /0001-use-rest\.md already records "Use REST"/);
    const replaced = await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST v2.', '--source', 'review', '--supersedes', '0001']);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.deepEqual((await readdir(path.join(dir, 'docs/decisions'))).filter((n) => /^\d/.test(n)).sort(), ['0001-use-rest.md', '0002-use-rest.md']);
  });
});

test('the first decision updates the line saying where the list is, without counting as an edit', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    assert.match(sectionOf(await read(dir, AGENTS), 'Decisions'), /No decision is recorded yet/);
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(sectionOf(text, 'Decisions'), /The list is `docs\/decisions\/README\.md`/);
    assert.equal(blockEdited(text), false, 'NASO moving its own line is not a review');
    assert.equal((await script('briefing')).code, 0);
  });
});

test('the check reports the line saying where the list is when a record was added by hand', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await put(dir, 'docs/decisions/0001-use-rest.md', '# 0001. Use REST\n\n- Status: accepted\n- Date: 2026-10-01\n- Source: kickoff\n');
    const res = await script('briefing');
    assert.equal(res.code, 1);
    assert.match(res.stdout, /WRONG[\s\S]*Decisions: the line saying where the list is is out of date\. Run: npx naso-dev decisions sync/);
    assert.equal((await naso(dir, ['decisions', 'sync'])).code, 0);
    assert.equal((await script('briefing')).code, 0);
  });
});

test('the check notes a toolset older than the command, without failing', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await writeFile(path.join(dir, '.naso/tooling/VERSION'), '0.0.1\n');
    const res = await script('briefing');
    assert.equal(res.code, 0, res.stdout);
    assert.match(res.stdout, /VERSIONS[\s\S]*\.naso\/tooling\/ is 0\.0\.1 and this command is/);
  });
});

test('ruleSources names the rule files a repository has, and never a .env file', () => {
  const groups = ruleSources([
    'CONTRIBUTING.md',
    '.github/CODEOWNERS',
    '.gitlab/merge_request_templates/Default.md',
    '.github/workflows/ci.yml',
    '.husky/pre-commit',
    'eslint.config.mjs',
    '.dockerignore',
    'docs/architecture.md',
    '.env',
    '.env.production',
    'src/app.ts',
  ]);
  const all = groups.flatMap((group) => group.files);
  for (const file of ['CONTRIBUTING.md', '.github/CODEOWNERS', '.gitlab/merge_request_templates/Default.md', '.github/workflows/ci.yml', '.husky/pre-commit', 'eslint.config.mjs', '.dockerignore', 'docs/architecture.md']) {
    assert.ok(all.includes(file), file);
  }
  assert.ok(!all.some((file) => file.startsWith('.env')), 'credentials are never listed');
  assert.ok(!all.includes('src/app.ts'));
});

test('review prints a prompt built from this repository: its rule files, its checks and its decisions', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, 'CONTRIBUTING.md', '# Contributing\n');
    await put(dir, 'CODEOWNERS', '* @team\n');
    await git('add', '-A');
    await git('commit', '-qm', 'rules');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);

    const first = await naso(dir, ['review']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /This is the first review/);
    assert.match(first.stdout, /Written rules and agent instructions: CONTRIBUTING\.md/);
    assert.match(first.stdout, /Owners: CODEOWNERS/);
    assert.match(first.stdout, /`npx naso-dev briefing` passes today: \d+ path claims verified/);
    assert.match(first.stdout, /Decisions: 0 accepted, 1 proposed and waiting for a person/);
    assert.match(first.stdout, /remove what does not earn its place/);
    assert.match(first.stdout, /Never run git add, commit,\n\s+stash, reset or checkout/);
    assert.match(first.stdout, /"What NASO gives this repository"/);

    const text = await read(dir, AGENTS);
    await writeFile(path.join(dir, AGENTS), text.replace('## When This Block Is Wrong', '## When This Block Is Wrong\n\nReviewed (`CONTRIBUTING.md` line 1).'));
    const second = await naso(dir, ['review']);
    assert.match(second.stdout, /has been reviewed before\. Do not start over/);
    assert.match(second.stdout, /AGENTS\.md is not tracked, so run `git log --since=/);
  });
});

test('review without a NASO block says to set NASO up first', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const res = await naso(dir, ['review']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /no NASO block/);
  });
});

test('the briefing tells every session to record decisions and to correct a wrong line', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.match(sectionOf(text, 'Decisions'), /Before asking the person a question, check the list/);
    assert.match(sectionOf(text, 'Decisions'), /record it before the session ends/);
    assert.match(sectionOf(text, 'When This Block Is Wrong'), /do not work around it silently/);
    assert.match(sectionOf(text, 'When This Block Is Wrong'), /`npx naso-dev review`/);
  });
});

test('refresh keeps the version and date the block was generated with, and says it refreshed', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    await writeFile(path.join(dir, AGENTS), text.replace(/<!-- version: \S+ -->/, '<!-- version: 0.0.1 -->').replace(/^> Generated by NASO \S+ on \S+ /m, '> Generated by NASO 0.0.1 on 2026-01-01 '));
    assert.equal((await naso(dir, ['briefing', 'refresh'])).code, 0);
    assert.equal((await naso(dir, ['briefing', 'refresh'])).code, 0);
    const after = await read(dir, AGENTS);
    assert.doesNotMatch(after, /<!-- version: 0\.0\.1 -->/);
    assert.match(after, /^> Generated by NASO 0\.0\.1 on 2026-01-01 \(refreshed to \d+\.\d+\.\d+ on \d{4}-\d{2}-\d{2}\) from /m);
    assert.equal((after.match(/refreshed to/g) ?? []).length, 1, 'a second refresh replaces the note, never stacks it');
  });
});

test('a decision update keeps what a person wrote after NASO\'s sentence on the same line', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    const lead = text.split('\n').find((line) => line.startsWith('Decisions the team already made'));
    await writeFile(path.join(dir, AGENTS), text.replace(lead, `${lead} Record 0001 lives in customer-api.`));
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);
    assert.match(await read(dir, AGENTS), /The list is `docs\/decisions\/README\.md`: one line per decision, linked to its record\. Record 0001 lives in customer-api\./);
    assert.equal((await script('briefing')).code, 0);
  });
});

test('decide puts <placeholders> in code, so Markdown does not swallow them as tags', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.equal((await naso(dir, ['decide', '--title', 'Branch names', '--decision', 'Branches are <type>/SCRUM-n, and `<kept>` stays.', '--source', 'CONTRIBUTING.md line 6'])).code, 0);
    assert.match(await read(dir, 'docs/decisions/0001-branch-names.md'), /Branches are `<type>`\/SCRUM-n, and `<kept>` stays\./);
  });
});

test('sync gives an older list the blank lines Prettier wants around its markers', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-use-rest.md', '# 0001. Use REST\n\n- Status: proposed\n- Date: 2026-10-01\n- Source: kickoff\n');
    await put(dir, 'docs/decisions/README.md', '# Decisions\n<!-- naso:decisions:start -->\nold\n<!-- naso:decisions:end -->\nNotes.\n');
    assert.equal((await naso(dir, ['decisions', 'sync'])).code, 0);
    const index = await read(dir, 'docs/decisions/README.md');
    assert.match(index, /^# Decisions\n\n<!-- naso:decisions:start -->\n\n/);
    assert.match(index, /\n\n<!-- naso:decisions:end -->\n\nNotes\.\n$/);
  });
});

test('a hand-written record with **Status:** and a Sources section is read as it is', async () => {
  const { parseDecision } = await import('../tooling/decisions.mjs');
  const record = parseDecision('docs/decisions/0001-auth.md', '# 0001. Customer authentication\n\n**Status:** proposed\n\n## Sources\n\n- [Figma wireflows](https://example.invalid), 11 Oct sync\n');
  assert.equal(record.status, 'proposed');
  assert.equal(record.source, 'Figma wireflows, 11 Oct sync');
});

test('naso-dev is pinned exactly where the repository pins its versions', async () => {
  const { devDependencyPlan, pinsExactVersions } = await import('../tooling/setup.mjs');
  assert.deepEqual(devDependencyPlan({ name: 'x' }, 'npm', '1.5.0', { exact: true }).commands[0], ['npm', ['install', '--save-dev', '--save-exact', 'naso-dev@1.5.0']]);
  assert.deepEqual(devDependencyPlan({ name: 'x' }, 'yarn', '1.5.0', { exact: true }).commands[0], ['yarn', ['add', '--dev', '--exact', 'naso-dev@1.5.0']]);
  await withRepo(async ({ dir }) => {
    assert.equal(await pinsExactVersions(dir, { dependencies: { a: '^1.0.0' } }), false);
    await put(dir, 'renovate.json', '{ "extends": ["config:recommended", ":pinAllExceptPeerDependencies"] }\n');
    assert.equal(await pinsExactVersions(dir, { dependencies: { a: '^1.0.0' } }), true);
  });
  await withRepo(async ({ dir }) => {
    assert.equal(await pinsExactVersions(dir, { dependencies: { a: '1.0.0', b: '2.3.4' }, devDependencies: { c: '5.0.0' } }), true);
  });
});

test('an existing .dockerignore gets .naso/, under its own comment', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.dockerignore', 'node_modules\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docker');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal(await read(dir, '.dockerignore'), "node_modules\n\n# Vendored by naso-dev; not part of this project's code\n.naso/\n");
  });
});

test('scripts that never exit are named, so nobody runs them as a check', async () => {
  const { detectLongRunningScripts } = await import('../tooling/scan.mjs');
  const found = detectLongRunningScripts({ scripts: { start: 'expo start', dev: 'nest start --watch', 'test:watch': 'vitest', test: 'vitest run', build: 'vite build', lint: 'eslint .' } });
  assert.deepEqual(found.map((entry) => entry.script), ['dev', 'start']);
});

test('review says when ESLint will lint the vendored toolset', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, 'eslint.config.mjs', 'export default [{ ignores: ["dist/"] }];\n');
    await git('add', '-A');
    await git('commit', '-qm', 'eslint');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.match((await naso(dir, ['review'])).stdout, /eslint\.config\.mjs does not ignore \.naso\//);
  });
});

test('setup says where decisions are kept among what the repository now has', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const res = await bare(['--yes']);
    const now = res.stdout.slice(res.stdout.indexOf('## What you have now'), res.stdout.indexOf('## Last step'));
    assert.match(now, /Decisions survive the session: AGENTS\.md tells every agent to read docs\/decisions\/README\.md/);
  });
});

test('refresh will not move a newer toolset back without --force', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await writeFile(path.join(dir, '.naso/tooling/VERSION'), '99.0.0\n');
    const res = await naso(dir, ['refresh']);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /\.naso\/tooling\/ is 99\.0\.0, newer than this tool[\s\S]*npm install --save-dev --save-exact naso-dev@99\.0\.0/);
    assert.equal((await read(dir, '.naso/tooling/VERSION')).trim(), '99.0.0', 'nothing was re-copied');
    assert.equal((await naso(dir, ['refresh', '--force'])).code, 0);
    assert.notEqual((await read(dir, '.naso/tooling/VERSION')).trim(), '99.0.0');
  });
});

test('the check notes package.json recording a different naso-dev than the toolset, or a caret where the repo pins', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const vendored = (await read(dir, '.naso/tooling/VERSION')).trim();
    const pkg = JSON.parse(await read(dir, 'package.json'));
    await put(dir, 'package.json', JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, 'naso-dev': '^0.9.0' } }));
    let res = await script('briefing');
    assert.equal(res.code, 0);
    assert.match(res.stdout, new RegExp(`package\\.json records naso-dev \\^0\\.9\\.0 and \\.naso/tooling/ is ${vendored.replace(/\./g, '\\.')}`));
    await put(dir, 'package.json', JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, 'naso-dev': `^${vendored}` } }));
    await put(dir, 'renovate.json', '{ "rangeStrategy": "pin" }\n');
    res = await script('briefing');
    assert.match(res.stdout, /this repository pins exact versions\. `npm install --save-dev --save-exact naso-dev@/);
  });
});

test('the check reports a decision count the list no longer bears out', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);
    const text = await read(dir, AGENTS);
    await writeFile(path.join(dir, AGENTS), text.replace('\n- Before proposing an approach', '\nAll 6 there are proposed.\n\n- Before proposing an approach'));
    const res = await script('briefing');
    assert.equal(res.code, 1);
    assert.match(res.stdout, /Decisions: says "All 6", and the list has 1/);
  });
});

test('the check reports a line citation past the end of the file it cites', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, 'CONTRIBUTING.md', '# Contributing\n\nOne rule.\n');
    await git('add', '-A');
    await git('commit', '-qm', 'contributing');
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    const cite = (lines) => text.replace('## When This Block Is Wrong', `## When This Block Is Wrong\n\nOne rule (\`CONTRIBUTING.md\` ${lines}).`);
    await writeFile(path.join(dir, AGENTS), cite('lines 2–3'));
    assert.equal((await script('briefing')).code, 0, 'inside the file passes');
    await writeFile(path.join(dir, AGENTS), cite('lines 6–13 and 16'));
    const res = await script('briefing');
    assert.equal(res.code, 1);
    assert.match(res.stdout, /`CONTRIBUTING\.md` line 16: the file has 3 lines/);
  });
});

test('review lists rows the docs mark Decided that no record cites yet', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/security.md', '# Security\n\n| Rule | Status |\n| --- | --- |\n| No secret in the bundle | **Decided** |\n| Pin dependencies | Proposed |\n| Rotate keys | Decided |\n');
    await git('add', '-A');
    await git('commit', '-qm', 'security');
    assert.equal((await bare(['--yes'])).code, 0);
    let out = (await naso(dir, ['review'])).stdout;
    assert.match(out, /Rows this repository's docs mark Decided that no record cites yet \(2\)/);
    assert.match(out, /docs\/security\.md line 5: No secret in the bundle/);
    assert.doesNotMatch(out, /Pin dependencies/);
    assert.equal((await naso(dir, ['decide', '--title', 'No secret in the bundle', '--decision', 'None.', '--source', 'docs/security.md line 5'])).code, 0);
    out = (await naso(dir, ['review'])).stdout;
    assert.match(out, /no record cites yet \(1\)/);
    assert.doesNotMatch(out, /line 5: No secret/);
  });
});

test('refresh says what it changed in AGENTS.md, and does not claim it touched no prose', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    await writeFile(path.join(dir, AGENTS), (await read(dir, AGENTS)).replace(/<!-- version: \S+ -->/, '<!-- version: 0.0.1 -->'));
    const res = await naso(dir, ['refresh']);
    assert.equal(res.code, 0, res.stdout);
    assert.doesNotMatch(res.stdout, /No prose touched/);
    assert.match(res.stdout, /noted the refresh on its "Generated by" line/);
  });
});

test('decide cuts a long file name at a hyphen, never mid-word', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const title = 'Server state lives in React Query with no Redux store and no versioned cache keys';
    assert.equal((await naso(dir, ['decide', '--title', title, '--decision', 'D.', '--source', 'kickoff'])).code, 0);
    const [name] = (await readdir(path.join(dir, 'docs/decisions'))).filter((n) => /^\d/.test(n));
    const slug = name.replace(/^\d+-/, '').replace(/\.md$/, '');
    assert.ok(slug.length <= 50, slug);
    assert.ok(title.toLowerCase().replace(/[^a-z0-9]+/g, '-').startsWith(`${slug}-`), `${slug} ends on a whole word`);
  });
});

test('proposed decision records are not listed among the repository\'s own rules; accepted ones get their own heading', async () => {
  const groups = ruleSources(['docs/architecture.md', 'docs/decisions/0001-use-rest.md', 'docs/decisions/README.md', 'docs/adr/0002-x.md']);
  assert.deepEqual(groups.flatMap((group) => group.files), ['docs/architecture.md']);
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/architecture.md', '# Architecture\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docs');
    assert.equal((await bare(['--yes'])).code, 0);
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);
    assert.equal((await naso(dir, ['decide', '--title', 'Use pnpm', '--decision', 'pnpm.', '--source', 'kickoff', '--accept'])).code, 0);
    const out = (await naso(dir, ['review'])).stdout;
    const rules = out.slice(out.indexOf("This repository's own rules"), out.indexOf('\n1. '));
    assert.doesNotMatch(rules, /0001-use-rest/, 'a proposal is not a rule');
    assert.match(rules, /Decisions a person accepted: docs\/decisions\/0002-use-pnpm\.md/);
  });
});

test('a Decided row is cited by a record that names its section, its line range or its text; another owner\'s row is decided elsewhere', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(
      dir,
      'docs/architecture.md',
      [
        '# Architecture', '', '## 1. Data', '', '| Choice | Status |', '| --- | --- |', '| Server state in React Query | Decided |', '',
        '## 2. Security', '', '| Rule | Status |', '| --- | --- |', '| Tokens live in SecureStore | Decided |', '| No analytics SDK | Decided |', '',
        '## 3. Integration', '', '| Contract | Status |', '| --- | --- |', '| Customer API owns the schema | Decided (customer-api) |', '| One API client per service | Decided (demo) |', '| Retry with backoff | Decided |', '',
      ].join('\n'),
    );
    await put(dir, 'docs/security.md', '# Security\n\n| Rule | Status |\n| --- | --- |\n| Pin every dependency | Decided |\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docs');
    assert.equal((await bare(['--yes'])).code, 0);
    const decide = (title, source) => naso(dir, ['decide', '--title', title, '--decision', `${title}.`, '--source', source]);
    assert.equal((await decide('Security rules', 'docs/architecture.md section 2')).code, 0);
    assert.equal((await decide('Pin every dependency', 'docs/security.md')).code, 0);
    assert.equal((await decide('Server state', 'docs/architecture.md lines 5-7')).code, 0);

    const out = (await naso(dir, ['review'])).stdout;
    const own = out.slice(out.indexOf('no record cites yet'), out.indexOf('decided by another repository'));
    assert.match(own, /no record cites yet \(2\)/, own);
    assert.match(own, /docs\/architecture\.md line 21: One API client per service/);
    assert.match(own, /docs\/architecture\.md line 22: Retry with backoff/);
    assert.doesNotMatch(out, /line \d+: (?:Tokens live|No analytics|Pin every|Server state)/);
    assert.match(out, /decided by another repository[^\n]*\n\s+- docs\/architecture\.md line 20: Customer API owns the schema \(customer-api\)/);
    assert.match(out, /--source "<file> line <n>"/);
  });
});

test('decide warns when the line it cites is already cited by another record', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/architecture.md', '# Architecture\n\n## 2. Security\n\nTokens live in SecureStore.\n\n## 3. Other\n\nText.\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docs');
    assert.equal((await naso(dir, ['decide', '--title', 'Security rules', '--decision', 'D.', '--source', 'docs/architecture.md section 2'])).code, 0);
    const again = await naso(dir, ['decide', '--title', 'Token storage', '--decision', 'D.', '--source', 'docs/architecture.md line 5']);
    assert.equal(again.code, 0, 'a warning, not a refusal');
    assert.match(again.stderr, /docs\/architecture\.md line 5 is already cited by docs\/decisions\/0001-security-rules\.md \("Security rules"\)/);
    const other = await naso(dir, ['decide', '--title', 'Other', '--decision', 'D.', '--source', 'docs/architecture.md line 9']);
    assert.doesNotMatch(other.stderr, /already cited/);
  });
});

test('review asks for a full review, not a diff, while the block is not committed yet', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Team notes\n\nBe kind.\n');
    await git('add', '-A');
    await git('commit', '-qm', 'agents');
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    await writeFile(path.join(dir, AGENTS), text.replace('## When This Block Is Wrong', '## When This Block Is Wrong\n\nReviewed.'));
    const out = (await naso(dir, ['review'])).stdout;
    assert.match(out, /the block is not committed yet: HEAD's AGENTS\.md has no <!-- naso:start --> marker/);
    assert.match(out, /Review the whole block/);
    assert.doesNotMatch(out, /git diff <that commit>\.\.HEAD/);
  });
});

test('the version note says exactly which command closes the gap, in the direction of the pin', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const pkg = JSON.parse(await read(dir, 'package.json'));
    const pin = async (version) => {
      await put(dir, 'package.json', JSON.stringify({ ...pkg, devDependencies: { 'naso-dev': version } }));
      await put(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/naso-dev': { version } } }));
    };
    // Ahead of the pin: the field case, toolset 1.5.1 and package.json and lockfile 1.5.0.
    await writeFile(path.join(dir, '.naso/tooling/VERSION'), '0.8.1\n');
    await pin('0.8.0');
    let out = (await script('briefing')).stdout;
    assert.match(out, /package\.json records naso-dev 0\.8\.0 \(installed 0\.8\.0\) and \.naso\/tooling\/ is 0\.8\.1, ahead of it\. `npm install --save-dev --save-exact naso-dev@0\.8\.1` records the toolset's version/);
    assert.match(out, /refresh refuses to move the toolset back without --force/);
    assert.doesNotMatch(out, /the version the team uses/);
    // Behind the pin.
    await writeFile(path.join(dir, '.naso/tooling/VERSION'), '0.7.0\n');
    out = (await script('briefing')).stdout;
    assert.match(out, /\.naso\/tooling\/ is 0\.7\.0, behind it\. `npx naso-dev@0\.8\.0 refresh` brings the toolset up to 0\.8\.0/);
    // No pin: the running version.
    await put(dir, 'package.json', JSON.stringify(pkg));
    out = (await script('briefing')).stdout;
    assert.match(out, /\.naso\/tooling\/ is 0\.7\.0 and this command is (\d+\.\d+\.\d+)\. `npx naso-dev@\1 refresh` brings the toolset up to \1\./);
  });
});

test('the check reports a curly quote that the cited lines do not say', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, 'CONTRIBUTING.md', '# Contributing\n\nMerge requests are squashed\nwhen they merge.\n\nRevert messages are accepted as they are.\n');
    await git('add', '-A');
    await git('commit', '-qm', 'contributing');
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    const cite = (line) => text.replace('## When This Block Is Wrong', `## When This Block Is Wrong\n\n${line}`);
    await writeFile(path.join(dir, AGENTS), cite('- `CONTRIBUTING.md` lines 3-4: “Merge requests are squashed when they merge.”'));
    assert.equal((await script('briefing')).code, 0, 'a quote across a line break, whitespace-normalised, passes');
    await writeFile(path.join(dir, AGENTS), cite('Reverts are fine: “Revert messages are accepted as they are.” (`CONTRIBUTING.md` line 3)'));
    let res = await script('briefing');
    assert.equal(res.code, 1);
    assert.match(res.stdout, /`CONTRIBUTING\.md` line 3: the quote is not in that line; first differing word: "Revert"/);
    await writeFile(path.join(dir, AGENTS), cite('- `CONTRIBUTING.md` line 6: “Revert messages are always accepted as they are.”'));
    res = await script('briefing');
    assert.match(res.stdout, /`CONTRIBUTING\.md` line 6: the quote is not in that line; first differing word: "always"/);
  });
});
