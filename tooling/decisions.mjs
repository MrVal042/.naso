// NASO decisions — what the team decided, recorded once, read by every session.
//
// A decision made in a meeting, a ticket, an email or a chat is lost to the next AI session,
// the next account and the next agent unless it is written where all of them look. So it is
// a file, one per decision, in the folder the repository already uses for decision records
// (else docs/decisions/), and AGENTS.md carries a list of them between two markers that
// `decide`, `decisions` and the pre-commit hook keep current.
//
// Three rules hold throughout:
//   - Every record says where it was decided. A decision with no source is a guess.
//   - Agents propose; people accept. `decide` writes `proposed`, and only a status a person
//     sets makes a decision binding.
//   - Nothing is deleted. A decision that no longer holds is superseded or rejected, and the
//     audit lists the ones that look invalid for a person to settle.
//
// Records in the common ADR layouts (Nygard's `## Status`, MADR's front matter) are read as
// they are. Only lines NASO is asked to change are rewritten.
//
// Zero external dependencies — Node.js core modules only.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, pathExists, run, nasoCommand, isMainModule } from './lib.mjs';
import { withLock } from './lock.mjs';

export const DECISIONS_START = '<!-- naso:decisions:start -->';
export const DECISIONS_END = '<!-- naso:decisions:end -->';

const STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated'];

/** Folders teams already keep decision records in, most specific first. */
const KNOWN_DIRS = [
  'docs/decisions',
  'docs/adr',
  'docs/adrs',
  'docs/architecture/decisions',
  'docs/decision-records',
  'doc/adr',
  'adr',
  'decisions',
];
const DEFAULT_DIR = 'docs/decisions';
const STALE_PROPOSAL_DAYS = 14;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad = (n) => String(Number(n)).padStart(4, '0');
const today = () => new Date().toISOString().slice(0, 10);
const isRecord = (name) => /\.md$/i.test(name) && !/^(?:readme|index|template|adr-template)/i.test(name);

/** The decisions folder: the one the repository uses, or the default it would get. */
export async function decisionsDir(cwd) {
  const pointer = (await readFile(path.join(cwd, '.adr-dir'), 'utf8').catch(() => '')).trim();
  for (const dir of [pointer, ...KNOWN_DIRS].filter(Boolean)) {
    const names = await readdir(path.join(cwd, dir)).catch(() => null);
    if (names && names.some(isRecord)) return { dir, exists: true };
  }
  return { dir: DEFAULT_DIR, exists: false };
}

/** A header field: `- Status: accepted`, `* Date: 2026-10-14`, or a bare `Date: …` line. */
function field(lines, names) {
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${names})(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, 'i');
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * One decision record, read from NASO's layout or a common ADR one.
 *
 * Status comes from a `Status:` line, a `## Status` heading's first line, or front matter;
 * "Superseded by 5. …" is split into the status and the record that replaced it.
 */
export function parseDecision(file, text) {
  const lines = String(text).split('\n');
  const front = {};
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const match = lines[i].match(/^([\w-]+)\s*:\s*(.+?)\s*$/);
      if (match) front[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, '');
    }
  }

  let statusText = field(lines, 'Status') ?? front.status ?? null;
  if (statusText === null) {
    const heading = lines.findIndex((line) => /^#{2,}\s+Status\s*$/i.test(line));
    if (heading !== -1) statusText = lines.slice(heading + 1).find((line) => line.trim())?.trim() ?? null;
  }
  const statusWord = statusText?.toLowerCase().match(/[a-z]+/)?.[0] ?? null;
  const supersededFromStatus = statusWord === 'superseded' ? statusText.match(/(\d+)/)?.[1] : null;
  const supersededField = field(lines, 'Superseded by')?.match(/(\d+)/)?.[1] ?? null;

  const heading = lines.find((line) => /^#\s+/.test(line)) ?? '';
  const title = heading
    .replace(/^#\s+/, '')
    .replace(/^(?:ADR[-\s]?)?\d+[.:)]?\s*[-—:]?\s*/i, '')
    .trim();
  const fromName = path.basename(file).match(/^(\d+)/)?.[1] ?? heading.match(/^#\s+(?:ADR[-\s]?)?(\d+)/i)?.[1] ?? null;
  const list = (value) =>
    value
      ? value
          .split(/[,;]/)
          .map((item) => item.replace(/`/g, '').trim())
          .filter(Boolean)
      : [];

  return {
    file,
    id: fromName ? pad(fromName) : path.basename(file, '.md'),
    title: title || path.basename(file, '.md'),
    status: statusWord,
    statusText,
    supersededBy: supersededFromStatus ? pad(supersededFromStatus) : supersededField ? pad(supersededField) : null,
    date: field(lines, 'Date') ?? front.date ?? null,
    by: field(lines, 'Decided by|Deciders|Decider') ?? front.deciders ?? null,
    source: field(lines, 'Source|Decided in|Origin') ?? front.source ?? null,
    applies: list(field(lines, 'Applies to|Scope') ?? front.applies),
    supersedes: list(field(lines, 'Supersedes')).map((item) => item.match(/(\d+)/)?.[1]).filter(Boolean).map(pad),
    reviewBy: field(lines, 'Review by|Revisit by|Review date') ?? front['review-by'] ?? null,
  };
}

/** Every record in the decisions folder, parsed, sorted by id. */
export async function readDecisions(cwd) {
  const { dir, exists } = await decisionsDir(cwd);
  const records = [];
  if (exists) {
    for (const name of (await readdir(path.join(cwd, dir))).filter(isRecord).sort()) {
      const text = await readFile(path.join(cwd, dir, name), 'utf8').catch(() => null);
      if (text !== null) records.push(parseDecision(`${dir}/${name}`, text));
    }
  }
  return { dir, exists, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

// ---------------------------------------------------------------------------
// The list in AGENTS.md
// ---------------------------------------------------------------------------

const indexLine = (record) =>
  `- [${record.id} ${record.title}](${record.file})` +
  (record.applies.length > 0 ? ` — applies to ${record.applies.join(', ')}` : '') +
  (record.source ? ` — ${record.source}` : '');

/** The block between the decisions markers: accepted first, then proposed, then a count. */
export function renderDecisionIndex({ records }) {
  const accepted = records.filter((record) => record.status === 'accepted');
  const proposed = records.filter((record) => record.status === 'proposed');
  const closed = records.length - accepted.length - proposed.length;
  const lines = [];
  if (records.length === 0) lines.push('No decisions recorded yet.');
  if (accepted.length > 0) lines.push('Accepted:', ...accepted.map(indexLine));
  if (proposed.length > 0) lines.push('', 'Proposed, not binding until a person accepts:', ...proposed.map(indexLine));
  if (closed > 0) lines.push('', `${closed} rejected or superseded, not listed.`);
  return `${DECISIONS_START}\n${lines.join('\n').replace(/^\n/, '')}\n${DECISIONS_END}`;
}

/**
 * Rewrite the list between the markers in AGENTS.md, and nothing else.
 *
 * Returns 'updated', 'current', 'no-markers' or 'no-briefing'. A briefing written before
 * decisions existed has no markers, and NASO does not add them to prose it no longer owns.
 */
export async function syncDecisionIndex(cwd) {
  const agentsPath = path.join(cwd, 'AGENTS.md');
  if (!(await pathExists(agentsPath))) return 'no-briefing';
  const block = renderDecisionIndex(await readDecisions(cwd));
  const outcome = await withLock(
    cwd,
    async () => {
      const text = await readFile(agentsPath, 'utf8');
      const start = text.indexOf(DECISIONS_START);
      const end = text.indexOf(DECISIONS_END);
      if (start === -1 || end === -1 || end < start) return 'no-markers';
      const next = text.slice(0, start) + block + text.slice(end + DECISIONS_END.length);
      if (next === text) return 'current';
      await writeFile(agentsPath, next, 'utf8');
      return 'updated';
    },
    { reason: 'refresh the decisions list in AGENTS.md' },
  );
  return outcome.ok ? outcome.value : 'locked';
}

// ---------------------------------------------------------------------------
// Writing records
// ---------------------------------------------------------------------------

const slugify = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'decision';

/** Write a new record. Proposed unless a person passes --accept. */
export async function createDecision(cwd, { title, decision, why = null, source, by = null, applies = [], supersedes = [], status = 'proposed', date = today() }) {
  const { dir, records } = await readDecisions(cwd);
  const next = pad(records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1);
  const file = `${dir}/${next}-${slugify(title)}.md`;
  const header = [
    `- Status: ${status}`,
    `- Date: ${date}`,
    ...(by ? [`- Decided by: ${by}`] : []),
    `- Source: ${source}`,
    ...(applies.length > 0 ? [`- Applies to: ${applies.join(', ')}`] : []),
    ...(supersedes.length > 0 ? [`- Supersedes: ${supersedes.map(pad).join(', ')}`] : []),
  ];
  const text = `# ${next}. ${title}\n\n${header.join('\n')}\n\n## Decision\n\n${decision}\n\n## Why\n\n${why ?? 'Not recorded.'}\n`;
  await mkdir(path.join(cwd, dir), { recursive: true });
  await writeFile(path.join(cwd, file), text, 'utf8');
  return { id: next, file };
}

/** Set one header field, keeping the record's own layout: bullet line, `## Heading`, or front matter. */
function setField(text, name, value) {
  const lines = text.split('\n');
  const bullet = lines.findIndex((line) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:`, 'i').test(line));
  if (bullet !== -1) {
    const prefix = lines[bullet].match(/^\s*(?:[-*]\s*)?(?:\*\*)?/)[0];
    lines[bullet] = `${prefix}${name}${prefix.includes('**') ? '**' : ''}: ${value}`;
    return lines.join('\n');
  }
  const heading = lines.findIndex((line) => new RegExp(`^#{2,}\\s+${name}\\s*$`, 'i').test(line));
  if (heading !== -1) {
    const body = lines.findIndex((line, i) => i > heading && line.trim());
    if (body !== -1 && !/^#/.test(lines[body])) lines[body] = value.charAt(0).toUpperCase() + value.slice(1);
    else lines.splice(heading + 1, 0, '', value);
    return lines.join('\n');
  }
  if (lines[0]?.trim() === '---') {
    const close = lines.indexOf('---', 1);
    const key = lines.findIndex((line, i) => i > 0 && i < close && new RegExp(`^${name}\\s*:`, 'i').test(line));
    if (key !== -1) lines[key] = `${name.toLowerCase()}: ${value}`;
    else lines.splice(close, 0, `${name.toLowerCase()}: ${value}`);
    return lines.join('\n');
  }
  // No header at all: the line goes after the title, or after the Status line when one exists.
  const status = lines.findIndex((line) => /^\s*[-*]\s*Status\s*:/i.test(line));
  const title = lines.findIndex((line) => /^#\s+/.test(line));
  const at = status !== -1 ? status + 1 : title !== -1 ? title + 1 : 0;
  lines.splice(at, 0, ...(status === -1 && title !== -1 ? ['', `- ${name}: ${value}`] : [`- ${name}: ${value}`]));
  return lines.join('\n');
}

async function rewrite(cwd, record, name, value) {
  const file = path.join(cwd, record.file);
  await writeFile(file, setField(await readFile(file, 'utf8'), name, value), 'utf8');
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * Records that no longer hold, as `{ level, id, text }`. Reads only; changes nothing.
 *
 * Errors are records that contradict each other or cannot be read as a decision at all.
 * Warnings are records that may have gone stale: no source, a scope that is gone, a
 * proposal nobody settled, a review date passed. Each says what to do about it.
 */
export async function auditDecisions(cwd, { on = today() } = {}) {
  const { records } = await readDecisions(cwd);
  const findings = [];
  const add = (level, id, text) => findings.push({ level, id, text });
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.id)) add('error', record.id, `two records share this id: ${byId.get(record.id).file} and ${record.file}`);
    byId.set(record.id, record);
  }

  const tracked = await run('git', ['ls-files', '-z'], { cwd });
  const files = tracked.ok ? tracked.stdout.split('\0').filter(Boolean) : [];
  const exists = async (target) =>
    files.some((f) => f === target.replace(/\/$/, '') || f.startsWith(target.endsWith('/') ? target : `${target}/`)) ||
    (await pathExists(path.join(cwd, target)));

  for (const record of records) {
    const open = record.status === 'accepted' || record.status === 'proposed';
    if (!record.status) add('error', record.id, 'no status: add "- Status: proposed" or "accepted"');
    else if (!STATUSES.includes(record.status)) add('error', record.id, `unknown status "${record.statusText}"`);

    for (const other of records) {
      if (other.status === 'accepted' && other.supersedes.includes(record.id) && open) {
        add('error', record.id, `${record.status}, but ${other.id} supersedes it. Run: ${nasoCommand()} decisions supersede ${record.id} --by ${other.id}`);
      }
    }
    if (record.supersededBy && !byId.has(record.supersededBy)) {
      add('error', record.id, `superseded by ${record.supersededBy}, which does not exist`);
    }
    if (!open) continue;

    if (!record.source) add('warn', record.id, 'no source: record where it was decided (meeting, ticket, email, doc)');
    if (!record.date) add('warn', record.id, 'no date');
    for (const target of record.applies) {
      if (!(await exists(target))) add('warn', record.id, `applies to ${target}, which is not in the repository`);
    }
    if (record.status === 'proposed' && record.date && daysBetween(record.date, on) > STALE_PROPOSAL_DAYS) {
      add('warn', record.id, `proposed ${daysBetween(record.date, on)} days ago and never accepted or rejected`);
    }
    if (record.status === 'accepted' && record.reviewBy && record.reviewBy < on) {
      add('warn', record.id, `review was due ${record.reviewBy}`);
    }
  }

  const agents = await readFile(path.join(cwd, 'AGENTS.md'), 'utf8').catch(() => null);
  if (agents?.includes(DECISIONS_START)) {
    const start = agents.indexOf(DECISIONS_START);
    const current = agents.slice(start, agents.indexOf(DECISIONS_END) + DECISIONS_END.length);
    if (current !== renderDecisionIndex({ records })) {
      add('warn', '----', `the list in AGENTS.md is out of date. Run: ${nasoCommand()} decisions sync`);
    }
  }

  const order = { error: 0, warn: 1 };
  return { records, findings: findings.sort((a, b) => a.id.localeCompare(b.id) || order[a.level] - order[b.level]) };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const listOf = (value) => (value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : []);

async function reportSync(cwd) {
  const outcome = await syncDecisionIndex(cwd);
  if (outcome === 'updated') console.log('Updated the decisions list in AGENTS.md.');
  if (outcome === 'no-markers') {
    console.log(`AGENTS.md has no decisions list yet. ${nasoCommand()} --force regenerates the NASO block with one.`);
  }
}

/** `naso-dev decide`: record a decision, proposed unless a person passes --accept. */
export async function decideMain(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv);
  const cwd = path.resolve(positional[0] ?? process.cwd());
  if (flags.has('help')) {
    console.log(`Record a decision so every later session, account and agent starts from it.

  ${nasoCommand()} decide --title "<what was decided>" --source "<where>" --decision "<the decision>"
      [--why "<reason>"] [--by "<who decided>"] [--applies src/api/,docs/api.md]
      [--supersedes 0003] [--accept]

--source is required: the meeting, ticket, email or doc it came from, by reference.
The record is written as proposed. --accept is for the person who made the decision;
an agent never passes it.`);
    return;
  }
  const title = values.get('title');
  const decision = values.get('decision');
  const source = values.get('source');
  const missing = !title ? '--title' : !decision ? '--decision' : !source ? '--source' : null;
  if (missing) {
    console.error(
      missing === '--source'
        ? 'naso-dev decide: --source is required: where was this decided? A meeting, ticket, email or doc, by reference.'
        : `naso-dev decide: ${missing} is required. See --help.`,
    );
    process.exitCode = 2;
    return;
  }
  const status = flags.has('accept') ? 'accepted' : 'proposed';
  const created = await createDecision(cwd, {
    title,
    decision,
    why: values.get('why') ?? null,
    source,
    by: values.get('by') ?? null,
    applies: listOf(values.get('applies')),
    supersedes: listOf(values.get('supersedes')),
    status,
  });
  console.log(`Recorded ${created.file} as ${status}.`);
  if (status === 'proposed') console.log(`A person accepts it with: ${nasoCommand()} decisions accept ${created.id}`);
  await reportSync(cwd);
}

/** `naso-dev decisions [list|accept|reject|supersede|audit|sync]`. */
export async function main(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv);
  const [sub = 'list', ...rest] = positional;
  const ids = rest.filter((item) => /^\d+$/.test(item)).map(pad);
  const target = rest.find((item) => !/^\d+$/.test(item));
  const cwd = path.resolve(target ?? process.cwd());

  if (flags.has('help')) {
    console.log(`Decisions the team made, in ${(await decisionsDir(cwd)).dir}/.

  ${nasoCommand()} decisions                    list them
  ${nasoCommand()} decisions accept <id>        a person accepts a proposed decision
  ${nasoCommand()} decisions reject <id>        a person rejects one
  ${nasoCommand()} decisions supersede <id> --by <newer-id>
  ${nasoCommand()} decisions audit              records that no longer hold; changes nothing
  ${nasoCommand()} decisions sync               refresh the list in AGENTS.md
  ${nasoCommand()} decide --help                record a new one`);
    return;
  }

  const { records, dir } = await readDecisions(cwd);
  const find = (id) => records.find((record) => record.id === id);

  if (sub === 'list') {
    if (records.length === 0) {
      console.log(`No decisions recorded in ${dir}/. Record one: ${nasoCommand()} decide --help`);
      return;
    }
    for (const record of records) {
      console.log(
        `${(record.status ?? 'no status').padEnd(11)} ${record.id}  ${record.title}` +
          (record.supersededBy ? `  by ${record.supersededBy}` : ''),
      );
    }
    return;
  }

  if (sub === 'accept' || sub === 'reject') {
    const record = find(ids[0]);
    if (!record) {
      console.error(`naso-dev decisions: no decision ${ids[0] ?? '(none given)'} in ${dir}/.`);
      process.exitCode = 1;
      return;
    }
    const status = sub === 'accept' ? 'accepted' : 'rejected';
    await rewrite(cwd, record, 'Status', status);
    console.log(`${record.id} ${record.title}: ${status}.`);
    await reportSync(cwd);
    return;
  }

  if (sub === 'supersede') {
    const older = find(ids[0]);
    const newer = find(pad(values.get('by') ?? ''));
    if (!older || !newer) {
      console.error(`naso-dev decisions: supersede needs two existing ids: supersede <old> --by <new>.`);
      process.exitCode = 1;
      return;
    }
    await rewrite(cwd, older, 'Status', `superseded by ${newer.id}`);
    if (!newer.supersedes.includes(older.id)) await rewrite(cwd, newer, 'Supersedes', [...newer.supersedes, older.id].join(', '));
    console.log(`${older.id} is superseded by ${newer.id}.`);
    await reportSync(cwd);
    return;
  }

  if (sub === 'sync') {
    await reportSync(cwd);
    return;
  }

  if (sub === 'audit') {
    const { findings } = await auditDecisions(cwd, { on: values.get('today') ?? today() });
    for (const finding of findings) {
      console.log(`${finding.level === 'error' ? 'ERROR' : 'WARN '}  ${finding.id}  ${finding.text}`);
    }
    const errors = findings.filter((finding) => finding.level === 'error').length;
    console.log(
      findings.length === 0
        ? `${plural(records.length, 'decision')}, no findings.`
        : `${plural(records.length, 'decision')}, ${plural(findings.length, 'finding')} (${plural(errors, 'error')}). Nothing was changed.`,
    );
    if (errors > 0) process.exitCode = 1;
    return;
  }

  console.error(`naso-dev decisions: unknown subcommand '${sub}'. See --help.`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) await main();
