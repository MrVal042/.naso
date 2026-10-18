// The AGENTS.md block: what it says, how it is created and re-stamped, and how it is checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toolVersion } from '../tooling/lib.mjs';
import { extractPathTokens, createBriefing, refreshBriefingStamp, readBriefingMarkerValue, NASO_START, NASO_END } from '../tooling/briefing.mjs';
import {
  BIN,
  AGENTS,
  exec,
  naso,
  withRepo,
  put,
  read,
  seedProject,
} from './helpers.mjs';

test('the tracked total equals the index, minus AGENTS.md, on a first --track run and every mode after', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    const indexCount = (await git('ls-files')).stdout.trim().split('\n').length;
    assert.equal(indexCount, 5);

    // First run with --track: AGENTS.md is not in the index yet, so nothing is subtracted.
    const first = await bare(['--yes', '--track']);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.match(await read(dir, AGENTS), /from the 5 tracked files, excluding AGENTS\.md/);

    // Once it is committed it is in the index, and it is the one file subtracted.
    await git('add', '-f', AGENTS);
    await git('commit', '-qm', 'track the briefing', '--no-verify');
    await bare(['--yes', '--force']);
    assert.match(await read(dir, AGENTS), /from the 5 tracked files, excluding AGENTS\.md/);
  });
});

test('the staging rule follows git, not the flag: --track with AGENTS.md ignored is local', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await put(dir, '.gitignore', 'AGENTS.md\n');
    await git('add', '.gitignore');
    await git('commit', '-qm', 'ignore the briefing');

    const res = await bare(['--yes', '--track']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    assert.match(text, /This file is not in the index and never will be/, 'an ignored file gets the local rule');
    assert.ok(!/stages it with the commit/.test(text));
  });
});

test('a first --track run gets the tracked staging rule, because the file is about to be committed', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await bare(['--yes', '--track']);
    const text = await read(dir, AGENTS);
    assert.match(text, /stages it with the commit/);
    assert.equal((await git('check-ignore', '-q', AGENTS)).code, 1, 'and git agrees it is not ignored');
  });
});

test('outside a git repository the header admits the counts came from a filesystem walk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naso-plain-'));
  try {
    await put(dir, 'src/index.ts', 'export const x = 1;\n');
    await put(dir, 'package.json', JSON.stringify({ name: 'plain' }));

    const res = await exec(process.execPath, [BIN, 'setup', dir, '--yes'], dir);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(text, /not a git repository/);
    assert.match(text, /filesystem walk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an excluded AGENTS.md is local-only, with no staging rule to follow', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);

    // The default run keeps AGENTS.md out of git entirely.
    const res = await script('setup', ['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(
      text,
      /- This file is not in the index and never will be: it is local to this machine/,
    );
    assert.match(text, /excluded through \.git\/info\/exclude so setup leaves no trace/);
    assert.match(text, /Do\n\s+not stage it, do not `git add -f` it/);
    assert.ok(
      !/staged with the commit/.test(text),
      'a rule about staging a line cannot apply to a file that is never committed',
    );

    const tracked = (await git('ls-files')).stdout;
    assert.ok(!tracked.includes('AGENTS.md'), 'the default run must not track AGENTS.md');
  });
});

test('a tracked AGENTS.md keeps the staging rule, because it is reviewable', async () => {
  await withRepo(async ({ dir, git, script }) => {
    await seedProject(dir, git);

    const res = await script('setup', ['--yes', '--track']);
    assert.equal(res.code, 0, res.stdout + res.stderr);

    const text = await read(dir, AGENTS);
    assert.match(
      text,
      /- When a commit adds a genuinely new area, the hook appends one line for it/,
    );
    assert.match(text, /stages it with the commit\. This file is tracked/);
    assert.ok(!/never will be/.test(text), 'a tracked file is not local-only');
  });
});

test('extractPathTokens pulls backtick-quoted paths', () => {
  const tokens = extractPathTokens('- `src/foo.ts` — does a thing\n`docs/guide.md`');
  assert.deepEqual(new Set(tokens), new Set(['src/foo.ts', 'docs/guide.md']));
});

test('createBriefing on a repository with no AGENTS.md writes the markers', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const result = await createBriefing(dir);
    assert.ok(result.ok);
    const text = await read(dir, AGENTS);
    assert.ok(text.includes(NASO_START));
    assert.ok(text.includes(NASO_END));
    assert.equal(readBriefingMarkerValue(text, 'version'), await toolVersion());
  });
});

test('createBriefing appends below a hand-written AGENTS.md and changes none of it', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const mine = '# My rules\n\nLine one, mine.\nLine two, also mine.\n';
    await writeFile(path.join(dir, AGENTS), mine, 'utf8');

    const result = await createBriefing(dir);
    assert.ok(result.ok);
    assert.ok(result.appended);

    const text = await read(dir, AGENTS);
    assert.ok(text.startsWith(mine), 'the hand-written part must be byte-identical at the top');
    assert.ok(text.includes(NASO_START));
    assert.ok(text.includes('Line one, mine.'));
  });
});

test('createBriefing without --force leaves an existing NASO block exactly as it is', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await createBriefing(dir);
    const before = await read(dir, AGENTS);

    const result = await createBriefing(dir);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'has-block');
    assert.equal(await read(dir, AGENTS), before, 'the file changed without --force');
  });
});

test('createBriefing --force replaces only what is between the markers', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const head = '# My rules\n\nAbove the block, hand written.\n\n';
    const tail = '\nBelow the block, also hand written.\n';
    await writeFile(
      path.join(dir, AGENTS),
      `${head}${NASO_START}\nstale generated content\n${NASO_END}${tail}`,
      'utf8',
    );

    // No digest: the block may carry reviewed edits, so --force alone keeps it.
    const kept = await createBriefing(dir, { force: true });
    assert.equal(kept.ok, false);
    assert.equal(kept.reason, 'edited');
    assert.match(await read(dir, AGENTS), /stale generated content/);

    const result = await createBriefing(dir, { force: true, discardEdits: true });
    assert.ok(result.ok);
    assert.ok(result.replacedBlock);
    assert.match(await read(dir, result.backup), /stale generated content/, 'the discarded block is backed up');

    const text = await read(dir, AGENTS);
    assert.ok(text.startsWith(head), 'prose above the block must survive --force');
    assert.ok(text.endsWith(tail), 'prose below the block must survive --force');
    assert.ok(!text.includes('stale generated content'), 'the old block should be gone');
    assert.ok(text.includes('Project Structure'));
  });
});

test('refreshBriefingStamp moves the stamp forward and never down', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await createBriefing(dir);

    const up = await refreshBriefingStamp(dir, { current: '99.0.0' });
    assert.equal(up.changed, true);
    assert.equal(readBriefingMarkerValue(await read(dir, AGENTS), 'version'), '99.0.0');

    const down = await refreshBriefingStamp(dir, { current: '1.0.0' });
    assert.equal(down.changed, false, 'a newer stamp must not be downgraded');
    assert.equal(readBriefingMarkerValue(await read(dir, AGENTS), 'version'), '99.0.0');
  });
});

test('refreshBriefingStamp rewrites only the two version stamps', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await createBriefing(dir);
    await writeFile(
      path.join(dir, AGENTS),
      (await read(dir, AGENTS)).replace('Project Structure', 'My hand-edited heading'),
      'utf8',
    );
    const before = (await read(dir, AGENTS))
      .split('\n')
      
      .filter((l) => !l.startsWith('<!-- version:') && !l.startsWith('> Generated by NASO '));

    await refreshBriefingStamp(dir, { current: '42.0.0' });

    const after = (await read(dir, AGENTS))
      .split('\n')
      
      .filter((l) => !l.startsWith('<!-- version:') && !l.startsWith('> Generated by NASO '));
    assert.deepEqual(after, before, 'refresh touched more than the stamp');
    assert.match(
      await read(dir, AGENTS),
      /^> Generated by NASO \S+ on \d{4}-\d{2}-\d{2} \(refreshed to 42\.0\.0 on \d{4}-\d{2}-\d{2}\) from /m,
      'the original version and date stay, and the refresh is said beside them',
    );
  });
});

test('words in backticks in a hand-written AGENTS.md are not checked as paths', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Ours\n\nScope a commit to one area (`web`, `mobile`, `sdk`).\nNever commit `sk_live` keys.\n');
    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /MISSING/);
    const check = await script('briefing');
    assert.equal(check.code, 0, check.stdout + check.stderr);
  });
});

test('the NASO block is still checked when it sits below hand-written text', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, AGENTS, '# Ours\n\nHand-written.\n');
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    await put(dir, AGENTS, text.replace(NASO_END, `- \`gone/nowhere.ts\` — claimed.\n\n${NASO_END}`));
    const check = await script('briefing');
    assert.notEqual(check.code, 0);
    assert.match(check.stdout, /MISSING[\s\S]*gone\/nowhere\.ts/);
  });
});

test('a long warning names a few paths and counts the rest, in AGENTS.md and on screen', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await put(dir, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test test/' } }));
    await put(dir, 'test/a.test.mjs', '');
    for (let i = 0; i < 12; i += 1) await put(dir, `e2e/case${String(i).padStart(2, '0')}.test.mjs`, '');
    await git('add', '-A');
    await git('commit', '-qm', 'tests');

    const res = await bare(['--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const text = await read(dir, AGENTS);
    for (const out of [text, res.stdout]) {
      assert.match(out, /12 tracked test files are outside it/);
      assert.match(out, /and 7 more/);
      assert.doesNotMatch(out, /case11\.test\.mjs/);
    }
  });
});

test('the commit standard is read from history: conventional subjects are stated, freeform ones are not invented', async () => {
  const commitAll = async (git, dir, subjects) => {
    for (const [i, subject] of subjects.entries()) {
      await put(dir, `src/f${i}.ts`, `export const v${i} = ${i};\n`);
      await git('add', '-A');
      await git('commit', '-qm', subject);
    }
  };
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await commitAll(git, dir, ['feat: a', 'fix(api): b', 'fix: c', 'docs: d', 'chore: e', 'test: f']);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    // One of six has a scope, so the form stated is the one the other five use.
    assert.match(text, /`type: summary`/);
    assert.match(text, /fix, chore, docs, feat, test/);
    assert.match(text, /No commit in the last \d+ carries a `Co-Authored-By:` trailer/);
  });
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    await commitAll(git, dir, ['Added login', 'wip', 'More stuff', 'Fix the thing', 'Update readme', 'tweaks']);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.doesNotMatch(text, /type\(scope\)/);
  });
});

test('the briefing carries no rules it cannot ground in the repository', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const text = await read(dir, AGENTS);
    assert.doesNotMatch(text, /Inventory first/);
    assert.doesNotMatch(text, /## Final Response Expectations/);
    assert.match(text, /`npm run lint`/, 'the closing note names the command this repository declares');
  });
});

test('guide does not call a one-paragraph section empty', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const res = await script('guide');
    const done = res.stdout.slice(res.stdout.indexOf('  When Done'));
    assert.doesNotMatch(done.split('\n').slice(0, 4).join('\n'), /nothing under this heading/);
  });
});

test('an untouched NASO block is replaced by --force; one edited in review is kept', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.ok((await createBriefing(dir)).ok);
    const fresh = await read(dir, AGENTS);
    assert.match(fresh, /^<!-- digest: [0-9a-f]{16} -->$/m);
    assert.ok((await createBriefing(dir, { force: true })).replacedBlock, 'nothing to lose, so --force replaces it');

    await writeFile(path.join(dir, AGENTS), fresh.replace('## Project Structure', '## Project Structure\n\nThe entry point is `package.json`, per review.'), 'utf8');
    const kept = await createBriefing(dir, { force: true });
    assert.equal(kept.reason, 'edited');
    assert.match(await read(dir, AGENTS), /per review/);
  });
});
