// The 1.5.3 field report, reproduced: two production repositories went from 1.4.0 to 1.5.2
// and their review found the problems this release fixes. One fixture holds all of them,
// and `review`, `briefing`, `doctor` and `decide` are each run against it.
//
// The fixture (seedFieldRepo): an Expo app with an ESLint 9 flat config, Prettier, Jest,
// GitLab CI and a merge request template; docs with Decided tables, one row owned by
// another repository; decision records whose sources say "section N"; naso-dev pinned at
// 1.5.0 in package.json and the lockfile. On top of it this file sets up NASO, leaves the
// block uncommitted, moves the toolset to 1.5.1, and adds a curly-quoted citation that
// points at the wrong line.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BIN, AGENTS, exec, withRepo, read, seedFieldRepo } from './helpers.mjs';

const naso = (dir, args) => exec(process.execPath, [BIN, ...args], dir);

/** The fixture after setup and a first, partial review, as the field left it. */
async function fieldState(dir, git, bare) {
  await seedFieldRepo(dir, git);
  const res = await bare(['--yes']);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  // A teammate's toolset upgrade that package.json never followed.
  await writeFile(path.join(dir, '.naso/tooling/VERSION'), '1.5.1\n');
  // A quote from CONTRIBUTING.md line 8, cited as line 12.
  const text = await read(dir, AGENTS);
  await writeFile(
    path.join(dir, AGENTS),
    text.replace('## When This Block Is Wrong', '## When This Block Is Wrong\n\n- Reverts: “Revert messages are accepted as git writes them.” (`CONTRIBUTING.md` line 12)'),
  );
}

test('field: review proposes only what is unrecorded, keeps proposals out of the rules, and plans the commit', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await fieldState(dir, git, bare);
    const res = await naso(dir, ['review']);
    assert.equal(res.code, 0, res.stderr);
    const out = res.stdout;

    // 1. Rows cited by "section N" sources are not proposed again; the other owner's row is apart.
    assert.match(out, /no record cites yet \(2\)/);
    assert.match(out, /docs\/architecture\.md line 21: One API client per backend service/);
    assert.match(out, /app\.config\.ts line 3: decided 2026-03-02: the app is portrait only/);
    for (const recorded of ['Server state lives', 'Auth tokens live', 'No analytics SDK', 'No secret in an EXPO_PUBLIC_ variable \\|', 'docs\\/security\\.md line 7']) {
      assert.doesNotMatch(out, new RegExp(`line \\d+: ${recorded}|${recorded}`), recorded);
    }
    assert.match(out, /decided by another repository \(1\)[^\n]*\n\s+- docs\/architecture\.md line 20: Customer API owns the OpenAPI schema \(customer-api\)/);

    // 2. The decisions folder is not the repository's rules; the accepted record is listed on its own.
    const rules = out.slice(out.indexOf("This repository's own rules"), out.indexOf('\n1. '));
    assert.match(rules, /Docs on architecture, structure and decisions: docs\/architecture\.md, docs\/security\.md\n/);
    assert.match(rules, /Decisions a person accepted: docs\/decisions\/0001-security-rules\.md\n/);
    assert.doesNotMatch(rules, /0002|0003/);

    // 3. The block is uncommitted: a full review, not a diff.
    assert.match(out, /the block is not committed yet/);
    assert.doesNotMatch(out, /git diff <that commit>\.\.HEAD/);

    // 4. The version gap names the command, toward the toolset (ahead of the pin).
    assert.match(out, /Versions: package\.json records naso-dev 1\.5\.0 \(installed 1\.5\.0\) and \.naso\/tooling\/ is 1\.5\.1, ahead of it\. `npm install --save-dev --save-exact naso-dev@1\.5\.1`/);

    // 5. Setup put .naso/ in the ESLint config, so the prompt has nothing to say about it.
    assert.doesNotMatch(out, /does not ignore \.naso\//);
    assert.match(await read(dir, 'eslint.config.js'), /defineConfig\(\[\n  \/\/ Vendored by naso-dev[^\n]*\n  \{ ignores: \['\.naso\/'\] \},\n  expoConfig,/);

    // 6. The misquote is in what the agent is told the check reports.
    assert.match(out, /WRONG: `CONTRIBUTING\.md` line 12: the quote is not in that line; first differing word: "Revert"/);

    // 11-13. Another writer, the whole toolchain, and the commit plan.
    assert.match(out, /`git write-tree`/);
    assert.match(out, /gitleaks dir \. --redact/);
    assert.match(out, /You are on branch main\. `CONTRIBUTING\.md` says branches follow `feature\/SCRUM-<n>-<summary>`, and this one does not\./);
    assert.match(out, /"Ready to commit: yes" or "Ready to commit: no"/);
  });
});

test('field: briefing reports the misquote and the version gap in the right direction', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await fieldState(dir, git, bare);
    const res = await naso(dir, ['briefing']);
    assert.equal(res.code, 1, res.stdout);
    assert.match(res.stdout, /WRONG \(1\)[^\n]*\n- `CONTRIBUTING\.md` line 12: the quote is not in that line; first differing word: "Revert"/);
    assert.match(res.stdout, /VERSIONS[\s\S]*\.naso\/tooling\/ is 1\.5\.1, ahead of it\. `npm install --save-dev --save-exact naso-dev@1\.5\.1` records the toolset's version \(refresh refuses to move the toolset back without --force\)/);
    assert.doesNotMatch(res.stdout, /with the version the team uses/);
    // Every fact setup derived passes its own check: the misquote is the only problem.
    assert.doesNotMatch(res.stdout, /MISSING|UNCOVERED/);
    // The block carries what agents had to add by hand, and none of what they removed.
    const text = await read(dir, AGENTS);
    assert.match(text, /Format: Prettier configured by `\.prettierrc`: printWidth 100, singleQuote true, trailingComma "all"/);
    assert.match(text, /runtimeVersion uses the appVersion policy/);
    assert.match(text, /## Merge Request Checklist/);
    assert.match(text, /a fresh clone has none until someone runs `npx naso-dev refresh` there/);
    for (const gone of ['Language mix', '**Ignored paths.**', '**Re-included.**', '**Local excludes.**', '**Import aliases.**']) assert.ok(!text.includes(gone), gone);
  });
});

test('field: doctor says what setup ran with, what ESLint prints for .naso/, and which way the pin goes', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await fieldState(dir, git, bare);
    const res = await naso(dir, ['doctor']);
    assert.match(res.stdout, /\.naso\/config\.json\s+setup ran with \d+\.\d+\.\d+ \(refresh never rewrites it\)/);
    assert.match(res.stdout, /OK\s+ESLint on \.naso\/\s+prints nothing/);
    assert.match(res.stdout, /WARN\s+naso-dev in package\.json\s+package\.json records naso-dev 1\.5\.0 \(installed 1\.5\.0\) and \.naso\/tooling\/ is 1\.5\.1, ahead of it/);
    assert.match(res.stdout, /OK\s+pre-commit hook/);
    const config = JSON.parse(await read(dir, '.naso/config.json'));
    assert.ok(config.setupVersion && !('version' in config));
  });
});

test('field: decide cuts a long name at a hyphen and warns on a line a "section N" record already cites', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await fieldState(dir, git, bare);
    const title = 'Auth tokens live in SecureStore and never in AsyncStorage or memory';
    const res = await naso(dir, ['decide', '--title', title, '--decision', 'Auth tokens live in SecureStore.', '--source', 'docs/architecture.md line 13']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stderr, /docs\/architecture\.md line 13 is already cited by docs\/decisions\/0001-security-rules\.md \("Security rules"\)/);
    const name = (await readdir(path.join(dir, 'docs/decisions'))).find((file) => file.startsWith('0004-'));
    assert.equal(name, '0004-auth-tokens-live-in-securestore-and-never-in.md');
    // The row it would have proposed again is the one the warning names; the uncited one is quiet.
    const quiet = await naso(dir, ['decide', '--title', 'One API client per backend service', '--decision', 'D.', '--source', 'docs/architecture.md line 21']);
    assert.doesNotMatch(quiet.stderr, /already cited/);
  });
});
