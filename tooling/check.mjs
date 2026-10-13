// NASO check — does the NASO block in AGENTS.md still match the repository? Every path it
// claims must exist, every real area must be named, and no placeholder may remain.
//
// Zero external dependencies — Node.js core modules only.

import {
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  run,
  coversUnit,
  escapeRegExp,
  section,
  nasoCommand,
} from './lib.mjs';
import {
  AGENTS_FILE,
  NASO_END,
  NASO_START,
  areasOf,
  listRepoFiles,
  topLevelEntries,
} from './scan.mjs';

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

// NASO's own tools are named in a briefing as commands, not as repo paths, so
// flagging them as MISSING would be noise.
const TOOL_SCRIPT_NAMES =
  /^(briefing|scan|render|check|guide|validate|doctor|init|setup|lib|lock|install|naso)\.mjs$/i;

/**
 * A path-shaped token: no globs, no angle brackets, no spaces.
 *
 * A briefing legitimately contains `git status`, `--no-verify` and
 * `type(scope): summary` in prose. Only path-shaped tokens are candidates for a
 * filesystem check; everything else is a false positive waiting to happen.
 */
const PATH_SHAPED_TOKEN = /^[\w.@~-]+(?:\/[\w.@~-]+)*\/?$/;

const MARKERS = ['TODO(fill)', 'TODO(describe)'];

/**
 * Remove fenced code blocks before hunting for path claims.
 *
 * Splitting on a single backtick misaligns the moment the document contains a
 * fence — an odd run of backticks means every span after it is read as the text
 * *between* two code spans, and prose gets tested as a filename. Stripping the
 * fences first removes the ambiguity, and it is also the correct scope: a path
 * inside a shell snippet is a command to run, not a claim about the repository.
 */
export function stripFencedBlocks(text) {
  return String(text).replace(/^```[\s\S]*?^```[ \t]*$/gm, '');
}

/**
 * Path tokens the briefing claims, from backticked spans only.
 *
 * Odd-index segments after splitting on ` are the inside of a code span; pairing
 * by regex instead would break on any stray backtick (see stripFencedBlocks).
 */
export function extractPathTokens(text) {
  const segments = stripFencedBlocks(text).split('`');
  const tokens = new Set();

  for (let i = 1; i < segments.length; i += 2) {
    const token = segments[i].trim();
    if (!token) continue;
    if (token.includes('*') || token.includes('<') || token.includes('>')) continue;
    if (token.includes(' ')) continue;
    if (token.startsWith('-')) continue;
    if (TOOL_SCRIPT_NAMES.test(token)) continue;
    if (!PATH_SHAPED_TOKEN.test(token)) continue;
    tokens.add(token);
  }
  return Array.from(tokens).sort();
}

/**
 * The repository's areas, by name, as git currently sees them.
 *
 * Directories only, `-z` only, exclusions and deletions applied — same rules as
 * `listRepoFiles`, because "the areas" has to mean one thing across the generator, the
 * checker, the guide and the pre-commit append.
 */
export async function listTopLevelEntries(cwd, { exclude = null } = {}) {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inside.ok) return null;

  const files = await listRepoFiles(cwd, { exclude });
  return areasOf(topLevelEntries(files)).map((entry) => `${entry.name}/`);
}

/** Which entries the briefing fails to cover. */
export function findUncovered(entries, briefingText) {
  return (entries ?? []).filter((entry) => !coversUnit(briefingText, entry));
}

/**
 * Compare the briefing against the repository.
 *
 * Three failure modes, and the middle one is the reason this exists: the old
 * shell snippet only ever checked paths the briefing claimed. It never checked
 * the areas that exist and were never mentioned, which is where the real gaps
 * are.
 */
export async function checkBriefing(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    return { ok: false, reason: 'missing', agentsPath, problems: [] };
  }

  const briefing = await readFile(agentsPath, 'utf8');
  // Only the NASO block is NASO's claim. Text around it is the owner's, and a hand-written
  // rule like "scope commits to `web` or `mobile`" names areas, not files — checking it as
  // paths failed a fresh setup on every repository whose own AGENTS.md used backticks.
  const start = briefing.indexOf(NASO_START);
  const end = briefing.indexOf(NASO_END);
  const claimed = start !== -1 && end > start ? briefing.slice(start, end) : briefing;
  const tokens = extractPathTokens(claimed);
  const entries = await listTopLevelEntries(cwd);

  const missing = [];
  for (const token of tokens) {
    if (!(await pathExists(path.join(cwd, token)))) missing.push(token);
  }

  const uncovered = findUncovered(entries, claimed);

  const markerCounts = MARKERS.map((marker) => ({
    marker,
    count: (claimed.match(new RegExp(escapeRegExp(marker), 'g')) ?? []).length,
  }));
  const unfilled = markerCounts.filter((m) => m.count > 0);

  const problems = [
    ...missing.map((m) => ({ kind: 'MISSING', item: m })),
    ...uncovered.map((u) => ({ kind: 'UNCOVERED', item: u })),
    ...unfilled.map((m) => ({ kind: 'UNFILLED', item: `${m.marker} x${m.count}` })),
  ];

  return {
    ok: problems.length === 0,
    agentsPath,
    briefing,
    tokens,
    entries: entries ?? [],
    missing,
    uncovered,
    unfilled,
    problems,
  };
}

/** Print a check result in the same shape for every caller. */
export function printCheck(result) {
  if (result.reason === 'missing') {
    console.error(`naso-dev briefing: no ${AGENTS_FILE} in ${path.dirname(result.agentsPath)}.`);
    console.error(`  Run \`${nasoCommand()} setup\` against this repository first.`);
    return;
  }

  if (result.missing.length > 0) {
    section(`MISSING (${result.missing.length}) — claimed by the briefing, not on disk`);
    for (const item of result.missing) console.log(`- ${item}`);
    console.log('');
  }

  if (result.uncovered.length > 0) {
    section(`UNCOVERED (${result.uncovered.length}) — on disk, absent from the briefing`);
    for (const item of result.uncovered) console.log(`- ${item}`);
    console.log('');
  }

  if (result.unfilled.length > 0) {
    section(`UNFILLED (${result.unfilled.length}) — placeholder markers still present`);
    for (const item of result.unfilled) console.log(`- ${item.marker}: ${item.count}`);
    console.log('');
  }

  if (result.ok) {
    console.log(
      `Briefing is consistent with the repository: ${result.tokens.length} path claim(s) ` +
        `verified, ${result.entries.length} top-level area(s) covered, no placeholders left.`,
    );
    return;
  }

  console.log(
    `${result.problems.length} problem(s). Every path the briefing claims must exist, every ` +
      'real area must be\nmentioned, and no placeholder marker may remain. ' +
      `Regenerate with \`${nasoCommand()} briefing create --force\`.`,
  );
}

/**
 * Write AGENTS.md from a fresh scan, under the repo lock.
 *
 * Generation re-reads the repository inside the lock and re-renders from what it
 * finds there, so two concurrent setups produce one of two complete briefings
 * rather than a half-written file.
 */
