// Decisions the team made, recorded once and read by every session, account and agent.
// Agents propose; a person accepts. The audit lists records that no longer hold and never
// deletes one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { parseDecision } from '../tooling/decisions.mjs';
import { BIN, AGENTS, exec, withRepo, put, read, exists, seedProject, sectionOf } from './helpers.mjs';

const naso = (dir, args) => exec(process.execPath, [BIN, ...args], dir);

test('parseDecision reads NASO records and the common ADR layouts', () => {
  const own = parseDecision(
    'docs/decisions/0003-use-rest.md',
    '# 0003. Use REST for the customer API\n\n- Status: accepted\n- Date: 2026-10-14\n- Decided by: product owner\n- Source: sprint planning, 2026-10-14\n- Applies to: src/api/, docs/api.md\n- Supersedes: 0001\n\n## Decision\n\nREST.\n',
  );
  assert.deepEqual(
    { id: own.id, title: own.title, status: own.status, date: own.date, by: own.by, source: own.source, applies: own.applies, supersedes: own.supersedes },
    { id: '0003', title: 'Use REST for the customer API', status: 'accepted', date: '2026-10-14', by: 'product owner', source: 'sprint planning, 2026-10-14', applies: ['src/api/', 'docs/api.md'], supersedes: ['0001'] },
  );

  const nygard = parseDecision('docs/adr/0002-record-decisions.md', '# 2. Record architecture decisions\n\nDate: 2025-01-02\n\n## Status\n\nSuperseded by [5. Use events](0005-use-events.md)\n\n## Context\n');
  assert.equal(nygard.id, '0002');
  assert.equal(nygard.title, 'Record architecture decisions');
  assert.equal(nygard.status, 'superseded');
  assert.equal(nygard.supersededBy, '0005');

  const madr = parseDecision('docs/decisions/0004-db.md', '---\nstatus: proposed\ndate: 2026-09-01\n---\n# Use Postgres\n');
  assert.equal(madr.status, 'proposed');
  assert.equal(madr.date, '2026-09-01');
  assert.equal(madr.title, 'Use Postgres');
});

test('decide records a proposed decision with its source, and refuses one without', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    const missing = await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST only.']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--source is required: where was this decided/);

    const res = await naso(dir, ['decide', '--title', 'Use REST for the customer API', '--decision', 'The app calls only REST endpoints.', '--source', 'PO email, 2026-10-14', '--by', 'product owner', '--applies', 'src/']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Recorded docs\/decisions\/0001-use-rest-for-the-customer-api\.md as proposed/);
    const text = await read(dir, 'docs/decisions/0001-use-rest-for-the-customer-api.md');
    assert.match(text, /^# 0001\. Use REST for the customer API$/m);
    assert.match(text, /^- Status: proposed$/m);
    assert.match(text, /^- Source: PO email, 2026-10-14$/m);
    assert.match(text, /^- Applies to: src\/$/m);
  });
});

test('decide writes into the folder the repository already uses, with the next number', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/adr/0001-record-decisions.md', '# 1. Record decisions\n\n## Status\n\nAccepted\n');
    await put(dir, 'docs/adr/0007-use-postgres.md', '# 7. Use Postgres\n\n## Status\n\nAccepted\n');
    await git('add', '-A');
    await git('commit', '-qm', 'adr');
    const res = await naso(dir, ['decide', '--title', 'Cache in Redis', '--decision', 'Redis.', '--source', 'architecture review 2026-10-10']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(await exists(dir, 'docs/adr/0008-cache-in-redis.md'));
    assert.equal(await exists(dir, 'docs/decisions'), false, 'no second decisions folder');
  });
});

test('AGENTS.md carries the rules and one link; the list lives in the decisions index, one line per record', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-use-rest.md', '# 0001. Use REST\n\n- Status: accepted\n- Date: 2026-10-01\n- Source: kickoff meeting\n- Applies to: src/\n');
    await put(dir, 'docs/decisions/0002-graphql.md', '# 0002. Try GraphQL\n\n- Status: proposed\n- Date: 2026-10-10\n- Source: Slack thread\n');
    await put(dir, 'docs/decisions/0003-soap.md', '# 0003. Use SOAP\n\n- Status: rejected\n- Date: 2026-09-01\n- Source: kickoff meeting\n');
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');
    assert.equal((await naso(dir, ['decisions', 'sync'])).code, 0);
    assert.equal((await bare(['--yes', '--track'])).code, 0);

    const section = sectionOf(await read(dir, AGENTS), 'Decisions');
    assert.match(section, /The list is `docs\/decisions\/README\.md`: one line per decision, linked to its record\./);
    assert.match(section, /Before proposing an approach, read the accepted decisions in it/);
    assert.match(section, /`npx naso-dev decide --title/);
    assert.match(section, /Never accept, reject or supersede a decision yourself/);
    assert.doesNotMatch(section, /0001|Use REST|naso:decisions/, 'no decision is listed in AGENTS.md');
    assert.ok(section.trim().split('\n').length <= 8, 'the section stays the same size however many decisions there are');
    assert.equal((await script('briefing')).code, 0);

    const index = await read(dir, 'docs/decisions/README.md');
    assert.match(index, /^## Accepted\n\n- \[0001 Use REST\]\(0001-use-rest\.md\) — applies to src\/ — kickoff meeting$/m);
    assert.match(index, /^## Proposed, not binding until a person accepts\n\n- \[0002 Try GraphQL\]\(0002-graphql\.md\) — Slack thread$/m);
    assert.match(index, /^## Rejected or superseded\n\n- \[0003 Use SOAP\]\(0003-soap\.md\) — rejected$/m);

    // Accepting rewrites the record and the list between the markers, nothing else.
    const agentsBefore = await read(dir, AGENTS);
    await put(dir, 'docs/decisions/README.md', `${index}\nNotes the team wrote under the list.\n`);
    const res = await naso(dir, ['decisions', 'accept', '0002']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Updated docs\/decisions\/README\.md\./);
    assert.match(await read(dir, 'docs/decisions/0002-graphql.md'), /^- Status: accepted$/m);
    const after = await read(dir, 'docs/decisions/README.md');
    assert.match(after, /^## Accepted\n\n- \[0001 Use REST\][^\n]*\n- \[0002 Try GraphQL\]\(0002-graphql\.md\) — Slack thread$/m);
    assert.match(after, /Notes the team wrote under the list\.\n$/);
    assert.equal(await read(dir, AGENTS), agentsBefore, 'AGENTS.md does not change when a decision does');
  });
});

test('with no decisions yet, AGENTS.md names no folder that is not there', async () => {
  await withRepo(async ({ dir, git, bare, script }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes'])).code, 0);
    const section = sectionOf(await read(dir, AGENTS), 'Decisions');
    assert.match(section, /No decision is recorded yet; the first one creates the list/);
    assert.doesNotMatch(section, /docs\//);
    assert.equal((await script('briefing')).code, 0);
  });
});

test('supersede marks both records, and the old one leaves the accepted list', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-use-rest.md', '# 0001. Use REST\n\n- Status: accepted\n- Date: 2026-10-01\n- Source: kickoff\n');
    await put(dir, 'docs/decisions/0002-use-grpc.md', '# 0002. Use gRPC\n\n- Status: accepted\n- Date: 2026-10-12\n- Source: architecture review\n');
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');
    const res = await naso(dir, ['decisions', 'supersede', '0001', '--by', '0002']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(await read(dir, 'docs/decisions/0001-use-rest.md'), /^- Status: superseded by 0002$/m);
    assert.match(await read(dir, 'docs/decisions/0002-use-grpc.md'), /^- Supersedes: 0001$/m);
    const list = await naso(dir, ['decisions']);
    assert.match(list.stdout, /accepted\s+0002\s+Use gRPC/);
    assert.match(list.stdout, /superseded\s+0001\s+Use REST\s+by 0002/);
  });
});

test('the audit lists records that no longer hold, and changes nothing', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-a.md', '# 0001. A\n\n- Status: accepted\n- Date: 2026-01-01\n- Applies to: src/legacy/\n');
    await put(dir, 'docs/decisions/0002-b.md', '# 0002. B\n\n- Status: accepted\n- Date: 2026-02-01\n- Source: review\n- Supersedes: 0001\n');
    await put(dir, 'docs/decisions/0003-c.md', '# 0003. C\n\n- Status: proposed\n- Date: 2026-01-05\n- Source: standup\n');
    await put(dir, 'docs/decisions/0004-d.md', '# 0004. D\n\n- Date: 2026-03-01\n- Source: email\n');
    await put(dir, 'docs/decisions/0005-e.md', '# 0005. E\n\n- Status: accepted\n- Date: 2026-03-01\n- Source: email\n- Review by: 2026-06-01\n');
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');
    const before = await readdir(`${dir}/docs/decisions`);

    const res = await naso(dir, ['decisions', 'audit', '--today', '2026-10-15']);
    assert.equal(res.code, 1, 'an inconsistent record is an error');
    const out = res.stdout;
    assert.match(out, /ERROR\s+0001\s+accepted, but 0002 supersedes it\. Run: npx naso-dev decisions supersede 0001 --by 0002/);
    assert.match(out, /WARN\s+0001\s+no source: record where it was decided/);
    assert.match(out, /WARN\s+0001\s+applies to src\/legacy\/, which is not in the repository/);
    assert.match(out, /WARN\s+0003\s+proposed 283 days ago and never accepted or rejected/);
    assert.match(out, /ERROR\s+0004\s+no status/);
    assert.match(out, /WARN\s+0005\s+review was due 2026-06-01/);
    assert.match(out, /WARN\s+----\s+the list in docs\/decisions\/README\.md is missing\. Run: npx naso-dev decisions sync/);
    assert.deepEqual(await readdir(`${dir}/docs/decisions`), before, 'the audit deletes nothing');
  });
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await put(dir, 'docs/decisions/0001-a.md', '# 0001. A\n\n- Status: accepted\n- Date: 2026-10-01\n- Source: kickoff\n');
    await git('add', '-A');
    await git('commit', '-qm', 'decisions');
    assert.equal((await naso(dir, ['decisions', 'sync'])).code, 0);
    const res = await naso(dir, ['decisions', 'audit', '--today', '2026-10-15']);
    assert.equal(res.code, 0, res.stdout);
    assert.match(res.stdout, /1 decision, no findings\./);
  });
});

test('the hook refuses a decision record with no status, and refreshes the list for a valid one', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes', '--track'])).code, 0);
    await git('add', '-A');
    await git('commit', '-qm', 'naso');

    await put(dir, 'docs/decisions/0001-bad.md', '# 0001. Bad\n\n- Source: chat\n');
    await git('add', 'docs/decisions/0001-bad.md');
    const bad = await exec(process.execPath, [`${dir}/.naso/tooling/validate.mjs`, dir, '--staged'], dir);
    assert.equal(bad.code, 1, bad.stdout);
    assert.match(bad.stdout, /Decision records.*0001: no status/);

    await put(dir, 'docs/decisions/0001-bad.md', '# 0001. Good now\n\n- Status: proposed\n- Date: 2026-10-15\n- Source: chat\n');
    await git('add', 'docs/decisions/0001-bad.md');
    const good = await exec(process.execPath, [`${dir}/.naso/tooling/validate.mjs`, dir, '--staged'], dir);
    assert.equal(good.code, 0, good.stdout);
    assert.match(await read(dir, 'docs/decisions/README.md'), /- \[0001 Good now\]\(0001-bad\.md\)/);
    const staged = (await git('diff', '--cached', '--name-only')).stdout;
    assert.match(staged, /docs\/decisions\/README\.md/, 'the refreshed list rides along with the commit');
    assert.doesNotMatch(await read(dir, AGENTS), /Good now/, 'no decision is listed in AGENTS.md');
  });
});

test('the first decision creating docs/ still gets its area line', async () => {
  await withRepo(async ({ dir, git, bare }) => {
    await seedProject(dir, git);
    assert.equal((await bare(['--yes', '--track'])).code, 0);
    await git('add', '-A');
    await git('commit', '-qm', 'naso');
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST.', '--source', 'kickoff'])).code, 0);
    await git('add', 'docs/decisions');
    const res = await exec(process.execPath, [`${dir}/.naso/tooling/validate.mjs`, dir, '--staged'], dir);
    assert.equal(res.code, 0, res.stdout);
    const text = await read(dir, AGENTS);
    const auto = text.slice(text.indexOf('<!-- naso:auto:start -->'), text.indexOf('<!-- naso:auto:end -->'));
    assert.match(auto, /`docs\/`/, 'docs/ is a new area and gets its line');
    assert.match(await read(dir, 'docs/decisions/README.md'), /- \[0001 Use REST\]\(0001-use-rest\.md\)/);
  });
});

test('decide skips a number another branch already uses in the same folder', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    await git('switch', '-q', '-c', 'feat/kyc');
    await put(dir, 'docs/decisions/0001-kyc-provider.md', '# 0001. KYC provider\n\n- Status: proposed\n- Source: ticket\n');
    await git('add', '-A');
    await git('commit', '-qm', 'docs: kyc decision');
    await git('switch', '-q', 'main');
    const res = await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST only.', '--source', 'kickoff']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Recorded docs\/decisions\/0002-use-rest\.md as proposed/);
    assert.match(res.stdout, /Skipped 0001: it is taken on feat\/kyc, which has not merged here\./);
  });
});

test('the decisions list is written with blank lines around headings, lists and markers', async () => {
  await withRepo(async ({ dir, git }) => {
    await seedProject(dir, git);
    assert.equal((await naso(dir, ['decide', '--title', 'Use REST', '--decision', 'REST only.', '--source', 'kickoff'])).code, 0);
    const index = await read(dir, 'docs/decisions/README.md');
    assert.match(index, /<!-- naso:decisions:start -->\n\n## Proposed, not binding until a person accepts\n\n- \[0001 Use REST\]\(0001-use-rest\.md\) — kickoff\n\n<!-- naso:decisions:end -->/);
  });
});
