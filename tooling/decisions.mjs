// NASO decisions — what the team decided, recorded once, read by every session.
//
// A decision made in a meeting, a ticket, an email or a chat is lost to the next AI session,
// the next account and the next agent unless it is written where all of them look. So it is
// a file, one per decision, in the folder the repository already uses for decision records
// (else docs/decisions/). The folder's README.md is the list: one line per decision, linked
// to its record, between two markers that `decide`, `decisions` and the pre-commit hook keep
// current. AGENTS.md holds the rules and one link to that list, so it stays the same size
// however many decisions a team makes.
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
import { parseArgs, pathExists, run, nasoCommand, isMainModule, DECISIONS_LEAD } from './lib.mjs';
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
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${names})(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(.+?)\\s*$`, 'i');
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** The first line under a `## <name>` heading, list marker and links' brackets removed. */
function sectionFirstLine(lines, names) {
  const at = lines.findIndex((line) => new RegExp(`^#{2,}\\s+(?:${names})\\s*$`, 'i').test(line));
  if (at === -1) return null;
  const first = lines.slice(at + 1).find((line) => line.trim() && !/^#/.test(line));
  return first ? first.replace(/^\s*[-*\d.]+\s*/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim() || null : null;
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
    source: field(lines, 'Source|Decided in|Origin') ?? front.source ?? sectionFirstLine(lines, 'Sources?|References') ?? null,
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
  const indexExists = await pathExists(path.join(cwd, indexFileOf(dir)));
  return { dir, exists, indexExists, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

// ---------------------------------------------------------------------------
// The list: README.md in the decisions folder
// ---------------------------------------------------------------------------

/** The index file for a decisions folder. */
export const indexFileOf = (dir) => `${dir}/README.md`;

/**
 * The opening line of the Decisions section in AGENTS.md, which says where the list is.
 *
 * It depends on whether the list exists yet, so it goes stale the moment the first decision
 * is recorded. `decide` and `decisions` rewrite it, and only it; the block digest leaves it
 * out, so that rewrite is not counted as a person's edit. No path is named for a list that
 * is not there: a backticked path is a claim that it exists.
 */
export { DECISIONS_LEAD };

export function decisionsLead({ dir, indexExists, records }) {
  const index = indexFileOf(dir);
  if (indexExists) return `${DECISIONS_LEAD} The list is \`${index}\`: one line per decision, linked to its record.`;
  if (records.length > 0) {
    return `${DECISIONS_LEAD} The list will be ${index}, one line per decision linked to its record, once \`${nasoCommand()} decisions sync\` writes it.`;
  }
  return `${DECISIONS_LEAD} No decision is recorded yet; the first one creates the list beside it.`;
}

/** The three forms decisionsLead writes, so a rewrite can tell NASO's words from a person's. */
const LEAD_FORMS = new RegExp(
  `^${DECISIONS_LEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (?:The list is \`[^\`]+\`: one line per decision, linked to its record\\.|` +
    `The list will be \\S+, one line per decision linked to its record, once \`[^\`]+\` writes it\\.|` +
    `No decision is recorded yet; the first one creates the list beside it\\.)`,
);

// The same markers scan.mjs exports; spelled here because scan.mjs imports this module.
const BLOCK_START = '<!-- naso:start -->';
const BLOCK_END = '<!-- naso:end -->';

/** The lead line inside an AGENTS.md block, or null when there is no block or no such line. */
export function leadLineIn(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end < start) return null;
  return text.slice(start, end).split('\n').find((line) => line.startsWith(DECISIONS_LEAD)) ?? null;
}

/** Bring the lead line in AGENTS.md up to date with the decisions on disk. True when it changed. */
export async function refreshDecisionsLead(cwd) {
  const file = path.join(cwd, 'AGENTS.md');
  const text = await readFile(file, 'utf8').catch(() => null);
  const line = text === null ? null : leadLineIn(text);
  if (line === null) return false;
  const ours = line.match(LEAD_FORMS)?.[0];
  if (!ours) return false;
  const next = decisionsLead(await readDecisions(cwd));
  if (ours === next) return false;
  // Only NASO's own sentence moves: text a person wrote after it on the same line stays.
  await writeFile(file, text.replace(line, next + line.slice(ours.length)), 'utf8');
  return true;
}

const indexLine = (record) =>
  `- [${record.id} ${record.title}](${path.basename(record.file)})` +
  (record.applies.length > 0 ? ` — applies to ${record.applies.join(', ')}` : '') +
  (record.source ? ` — ${record.source}` : '');

const closedLine = (record) =>
  `- [${record.id} ${record.title}](${path.basename(record.file)}) — ` +
  (record.supersededBy ? `superseded by ${record.supersededBy}` : record.status ?? 'no status');

/**
 * The list between the markers: accepted, then proposed, then the closed ones.
 *
 * Every record gets a line, closed ones included: this file, not AGENTS.md, is where the
 * history is read, and a superseded decision is the answer to "didn't we decide this?".
 */
export function renderDecisionIndex({ records }) {
  const accepted = records.filter((record) => record.status === 'accepted');
  const proposed = records.filter((record) => record.status === 'proposed');
  const closed = records.filter((record) => !accepted.includes(record) && !proposed.includes(record));
  const sections = [];
  if (records.length === 0) sections.push('No decisions recorded yet.');
  // Blank lines around every heading, list and marker: the shape Prettier writes, so a
  // repository whose CI runs `prettier --check` does not fail on a file NASO wrote.
  const section = (heading, lines) => `${heading}\n\n${lines.join('\n')}`;
  if (accepted.length > 0) sections.push(section('## Accepted', accepted.map(indexLine)));
  if (proposed.length > 0) sections.push(section('## Proposed, not binding until a person accepts', proposed.map(indexLine)));
  if (closed.length > 0) sections.push(section('## Rejected or superseded', closed.map(closedLine)));
  return `${DECISIONS_START}\n\n${sections.join('\n\n')}\n\n${DECISIONS_END}`;
}

const INDEX_INTRO =
  '# Decisions\n\n' +
  'One file per decision, each with who decided and where. Agents propose with `naso-dev decide`; ' +
  'a person accepts with `naso-dev decisions accept <id>`. NASO keeps the list between the markers ' +
  'below; write anything else around them.\n\n';

/**
 * Rewrite the list in the decisions folder's README.md, and nothing outside its markers.
 *
 * Returns `{ outcome, file }`: 'created' (a new README.md), 'updated', 'current', 'appended'
 * (an existing README.md had no markers, so the list went at its end) or 'none' (no records).
 */
export async function syncDecisionIndex(cwd) {
  const decisions = await readDecisions(cwd);
  const file = indexFileOf(decisions.dir);
  if (decisions.records.length === 0) return { outcome: 'none', file };
  const full = path.join(cwd, file);
  const block = renderDecisionIndex(decisions);
  const outcome = await withLock(
    cwd,
    async () => {
      const text = await readFile(full, 'utf8').catch(() => null);
      if (text === null) {
        await writeFile(full, `${INDEX_INTRO}${block}\n`, 'utf8');
        return 'created';
      }
      const start = text.indexOf(DECISIONS_START);
      const end = text.indexOf(DECISIONS_END);
      if (start === -1 || end === -1 || end < start) {
        await writeFile(full, `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`, 'utf8');
        return 'appended';
      }
      // Prettier wants a blank line on each side of the markers; 1.3.x wrote none, and this is
      // the one place that list is ever rewritten.
      const before = text.slice(0, start).replace(/\n*$/, start > 0 ? '\n\n' : '');
      const rest = text.slice(end + DECISIONS_END.length).replace(/^\n*/, '');
      const next = before + block + (rest ? `\n\n${rest}` : '\n');
      if (next === text) return 'current';
      await writeFile(full, next, 'utf8');
      return 'updated';
    },
    { reason: `refresh the decisions list in ${file}` },
  );
  return { outcome: outcome.ok ? outcome.value : 'locked', file };
}

// ---------------------------------------------------------------------------
// Writing records
// ---------------------------------------------------------------------------

/**
 * The file name's words: at most 50 characters, cut at the last hyphen before that, so a
 * name never ends mid-word ("…-no-ve.md"). A single word longer than 50 is cut where it must.
 */
export const slugify = (title) => {
  const full = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (full.length <= 50) return full || 'decision';
  const cut = full.slice(0, 51).lastIndexOf('-');
  return (cut > 0 ? full.slice(0, cut) : full.slice(0, 50)).replace(/-+$/, '') || 'decision';
};

/**
 * `<placeholder>` outside a code span, put in one. GitLab and GitHub read a bare `<type>` as
 * an HTML tag and show nothing, so a record saying "`<type>/SCRUM-n`" rendered as "/SCRUM-n".
 */
export function codeAngles(text) {
  return String(text)
    .split('`')
    .map((part, i) => (i % 2 === 0 ? part.replace(/<[^<>\n`]+>/g, (tag) => `\`${tag}\``) : part))
    .join('`');
}

/** Write a new record. Proposed unless a person passes --accept. */
export async function createDecision(cwd, { title, decision, why = null, considered = [], source, by = null, applies = [], supersedes = [], status = 'proposed', date = today() }) {
  [title, decision, why] = [title, decision, why].map((value) => (value === null ? null : codeAngles(value)));
  considered = considered.map(codeAngles);
  const { dir, records } = await readDecisions(cwd);
  const elsewhere = await numbersOnOtherBranches(cwd, dir);
  const highest = Math.max(0, ...records.map((record) => Number(record.id) || 0), ...elsewhere.keys());
  const next = pad(highest + 1);
  const file = `${dir}/${next}-${slugify(title)}.md`;
  const header = [
    `- Status: ${status}`,
    `- Date: ${date}`,
    ...(by ? [`- Decided by: ${by}`] : []),
    `- Source: ${source}`,
    ...(applies.length > 0 ? [`- Applies to: ${applies.join(', ')}`] : []),
    ...(supersedes.length > 0 ? [`- Supersedes: ${supersedes.map(pad).join(', ')}`] : []),
  ];
  // The options turned down are what stop the next session proposing them again.
  const rejected = considered.length > 0 ? `\n## Considered and not chosen\n\n${considered.map((item) => `- ${item}`).join('\n')}\n` : '';
  const text = `# ${next}. ${title}\n\n${header.join('\n')}\n\n## Decision\n\n${decision}\n\n## Why\n\n${why ?? 'Not recorded.'}\n${rejected}`;
  await mkdir(path.join(cwd, dir), { recursive: true });
  await writeFile(path.join(cwd, file), text, 'utf8');
  const local = new Set(records.map((record) => Number(record.id) || 0));
  const skipped = [...elsewhere.entries()].filter(([n]) => !local.has(n)).sort((a, b) => a[0] - b[0]);
  return { id: next, file, skipped: skipped.map(([n, refs]) => ({ id: pad(n), refs })) };
}

/**
 * Decision numbers other branches already use in the same folder, with which branches.
 *
 * Two branches that each write 0002 collide when the second one merges, and nobody sees it
 * until then. Reading every local and remote branch's tree costs one git call per branch
 * and changes nothing; a repository without branches or git returns an empty map.
 */
export async function numbersOnOtherBranches(cwd, dir) {
  const refs = await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { cwd });
  const found = new Map();
  if (!refs.ok) return found;
  for (const ref of refs.stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith('/HEAD'))) {
    const tree = await run('git', ['ls-tree', '--name-only', ref, '--', `${dir}/`], { cwd });
    if (!tree.ok) continue;
    for (const name of tree.stdout.split('\n')) {
      const n = Number(path.posix.basename(name).match(/^(\d{1,5})-/)?.[1]);
      if (!n) continue;
      if (!found.has(n)) found.set(n, []);
      if (!found.get(n).includes(ref)) found.get(n).push(ref);
    }
  }
  return found;
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

  const { dir } = await decisionsDir(cwd);
  const index = await readFile(path.join(cwd, indexFileOf(dir)), 'utf8').catch(() => null);
  const start = index?.indexOf(DECISIONS_START) ?? -1;
  const current = start === -1 ? null : index.slice(start, index.indexOf(DECISIONS_END) + DECISIONS_END.length);
  if (records.length > 0 && current !== renderDecisionIndex({ records })) {
    add('warn', '----', `the list in ${indexFileOf(dir)} is ${current === null ? 'missing' : 'out of date'}. Run: ${nasoCommand()} decisions sync`);
  }

  const order = { error: 0, warn: 1 };
  return { records, findings: findings.sort((a, b) => a.id.localeCompare(b.id) || order[a.level] - order[b.level]) };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const listOf = (value) => (value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : []);

async function reportSync(cwd) {
  const { outcome, file } = await syncDecisionIndex(cwd);
  if (outcome === 'created') console.log(`Wrote the list of decisions: ${file}.`);
  if (outcome === 'updated') console.log(`Updated ${file}.`);
  if (outcome === 'appended') console.log(`Added the list of decisions at the end of ${file}, between NASO markers.`);
  if (outcome === 'locked') console.log(`${file} is locked by another writer; run ${nasoCommand()} decisions sync after.`);
  if (outcome !== 'locked' && (await refreshDecisionsLead(cwd))) console.log(`Updated the line in AGENTS.md that says where the list is.`);
}

/** `naso-dev decide`: record a decision, proposed unless a person passes --accept. */
export async function decideMain(argv = process.argv.slice(2)) {
  const { flags, values, lists, positional } = parseArgs(argv, { valued: ['why'] });
  const cwd = path.resolve(positional[0] ?? process.cwd());
  if (flags.has('help')) {
    console.log(`Record a decision so every later session, account and agent starts from it.

  ${nasoCommand()} decide --title "<what was decided>" --source "<where>" --decision "<the decision>"
      [--why "<reason>"] [--considered "<option> — <why not>"]... [--by "<who decided>"]
      [--applies src/api/,docs/api.md] [--supersedes 0003] [--accept]

--source is required: the meeting, ticket, email or doc it came from, by reference.
--considered repeats, one per option the team turned down, so no later session offers it again.
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
  // A stray word read as the target once created a folder named after a sentence, with a
  // second decisions tree inside it. The target is a repository that is already there.
  if (!(await pathExists(cwd))) {
    console.error(`naso-dev decide: target directory does not exist: ${cwd}. Quote every value, and pass the repository as the only bare argument.`);
    process.exitCode = 2;
    return;
  }
  const same = (await readDecisions(cwd)).records.find((record) => record.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (same && !listOf(values.get('supersedes')).map(pad).includes(same.id)) {
    console.error(
      `naso-dev decide: ${same.file} already records "${same.title}" (${same.status ?? 'no status'}). ` +
        `Say it once: change that record, or record the replacement with --supersedes ${same.id}.`,
    );
    process.exitCode = 2;
    return;
  }
  const status = flags.has('accept') ? 'accepted' : 'proposed';
  const created = await createDecision(cwd, {
    title,
    decision,
    why: values.get('why') ?? null,
    considered: lists.get('considered') ?? [],
    source,
    by: values.get('by') ?? null,
    applies: listOf(values.get('applies')),
    supersedes: listOf(values.get('supersedes')),
    status,
  });
  console.log(`Recorded ${created.file} as ${status}.`);
  for (const { id, refs } of created.skipped) {
    console.log(`Skipped ${id}: it is taken on ${refs.join(', ')}, which has not merged here.`);
  }
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
  ${nasoCommand()} decisions sync               refresh the list in the decisions folder's README.md
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
