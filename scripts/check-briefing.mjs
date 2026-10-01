#!/usr/bin/env node
// NASO Check-Briefing — is AGENTS.md true about this repository?
//
// Replaces the shell snippet SETUP_INSTRUCTIONS.md used to carry. That snippet
// only checked paths the briefing claims exist. It never checked the inverse —
// the areas that exist in the repo and that nobody mentioned — which is where
// the real gaps are. This does both, in one place, cross-platform.
//
// Reports:
//   MISSING    a path the briefing claims that does not exist on disk
//   UNCOVERED  a top-level area the repo has that the briefing never mentions
//   TODO       unfilled TODO(fill) / TODO(describe) markers still in the file
//
// Reads AGENTS.md and nothing else. Never opens a project file.
//
// Usage: node .naso/scripts/check-briefing.mjs [target-dir]
// Exit:  0 clean, 1 if anything is missing/uncovered/unfilled
//
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  parseArgs,
  run,
  coversUnit,
  countTodoMarkers,
  isRootNoise,
  isNoisyDir,
  escapeRegExp,
} from './lib.mjs';

const AGENTS_FILE = 'AGENTS.md';

// NASO's own scripts are named in the briefing as tools, not as repo paths, so
// flagging them as MISSING would be noise.
const TOOL_SCRIPT_NAMES =
  /^(validate|guard|bootstrap|lib|lock|check-briefing)\.mjs$/i;

/**
 * A path-shaped token: no globs, no angle brackets, no spaces.
 *
 * A briefing legitimately contains `` `git status` ``, `` `--no-verify` `` and
 * `` `type(scope): summary` `` in prose. Only path-shaped tokens are candidates
 * for a filesystem check; everything else is a false positive waiting to
 * happen, which is how the old snippet ended up reporting command flags as
 * missing files.
 */
const PATH_SHAPED_TOKEN = /^[\w.@~-]+(?:\/[\w.@~-]+)*\/?$/;

const MARKERS = ['TODO(fill)', 'TODO(describe)'];

/**
 * Extract candidate path tokens from backticked spans.
 *
 * Split on backticks and take the odd-index segments rather than regex-matching
 * `` `...` `` pairs. Pairing by regex misaligns the moment the document contains
 * an odd number of backticks — a fenced code block, a lone backtick in prose —
 * and every span after that point gets read as the text *between* two
 * backticks. That is how ` or ` ended up being tested as a filename.
 */
export function extractPathTokens(text) {
  const segments = text.split('`');
  const tokens = new Set();

  // Segments 1, 3, 5, ... are the inside of a code span.
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

/** Top-level entries git knows about, minus build output and root noise. */
export async function listTopLevelEntries(cwd) {
  // -c cached: committed. -o others: untracked. --exclude-standard: skip
  // anything the repo already ignores (which is what keeps a locally-excluded
  // AGENTS.md from being reported as an uncovered area).
  const res = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd });
  if (!res.ok) return null;

  const entries = new Set();
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.split('/')[0];
    if (first === '.git') continue;
    if (first.startsWith('.')) continue;
    if (trimmed.includes('/')) {
      if (!isNoisyDir(first)) entries.add(`${first}/`);
    } else if (!isRootNoise(first)) {
      entries.add(first);
    }
  }
  return Array.from(entries).sort();
}

/** Which entries the briefing fails to cover. */
export function findUncovered(entries, briefingText) {
  return entries.filter((entry) => !coversUnit(briefingText, entry));
}

async function main() {
  const { positional } = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso check-briefing: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    console.error(
      `naso check-briefing: no ${AGENTS_FILE} in ${cwd}.\n` +
        '  Run bootstrap.mjs against this repository first.',
    );
    process.exitCode = 1;
    return;
  }

  const briefing = await readFile(agentsPath, 'utf8');

  console.log(`# NASO Check-Briefing — ${agentsPath}`);
  console.log('');

  const problems = [];

  // 1. MISSING — paths the briefing claims that do not exist.
  const tokens = extractPathTokens(briefing);
  const missing = [];
  for (const token of tokens) {
    const ok = await pathExists(path.join(cwd, token));
    if (!ok) missing.push(token);
  }
  if (missing.length > 0) {
    console.log(`## MISSING (${missing.length}) — claimed by the briefing, not on disk`);
    for (const token of missing) console.log(`- ${token}`);
    problems.push(...missing.map((m) => `MISSING ${m}`));
    console.log('');
  }

  // 2. UNCOVERED — real areas the briefing never mentions.
  const entries = await listTopLevelEntries(cwd);
  if (entries === null) {
    console.log('## UNCOVERED — skipped (not a git repository)');
    console.log('');
  } else {
    const uncovered = findUncovered(entries, briefing);
    if (uncovered.length > 0) {
      console.log(`## UNCOVERED (${uncovered.length}) — on disk, absent from the briefing`);
      for (const entry of uncovered) console.log(`- ${entry}`);
      problems.push(...uncovered.map((u) => `UNCOVERED ${u}`));
      console.log('');
    }
  }

  // 3. TODO — markers proving the fill-in is incomplete.
  const remaining = countTodoMarkers(briefing);
  const markerCounts = MARKERS.map((marker) => ({
    marker,
    count: (briefing.match(new RegExp(escapeRegExp(marker), 'g')) ?? []).length,
  }));
  if (remaining > 0) {
    console.log(`## UNFILLED (${remaining}) — TODO markers still present`);
    for (const { marker, count } of markerCounts) {
      if (count > 0) console.log(`- ${marker}: ${count}`);
    }
    problems.push(...markerCounts.filter((m) => m.count > 0).map((m) => `TODO ${m.marker} x${m.count}`));
    console.log('');
  }

  if (problems.length === 0) {
    console.log(
      `Briefing is consistent with the repository. ` +
        `Checked ${tokens.length} path claim(s) and ${entries?.length ?? 0} top-level area(s).`,
    );
    process.exitCode = 0;
    return;
  }

  console.log(
    `${problems.length} problem(s) found. Every path the briefing claims must exist, ` +
      'every real area must be mentioned, and no TODO marker may remain\n' +
      'before a human confirms the briefing.',
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`naso check-briefing: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
