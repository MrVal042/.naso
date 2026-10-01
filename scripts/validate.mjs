#!/usr/bin/env node
// NASO Validate — the mechanical gate that runs before commits.
//
// Two modes:
//   --staged (the git pre-commit hook): the project's own prettier/eslint on
//     staged files, a branch-naming check, an AGENTS.md freshness notice, and a
//     one-line append to AGENTS.md when this commit adds something genuinely
//     new. Targets < 2s so it never tempts a `--no-verify` bypass.
//   default (CI / manual "done" gate): whole-project lint, typecheck, tests,
//     and format check.
//
// Generic by design: it discovers the project's package manager, its scripts,
// and its formatter from the repo itself. Nothing here assumes a language,
// framework, or directory layout.
//
// Usage: node .naso/scripts/validate.mjs [target-dir] [--staged] [--no-append]
// Zero external dependencies — Node.js core modules only.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  readJSONFile,
  allExisting,
  detectPackageManager,
  pmRunCommand,
  pmExecCommand,
  hasLocalBin,
  getStagedFiles,
  parseArgs,
  run,
  compareVersions,
  toolVersion,
  coversUnit,
  countTodoMarkers,
  isRootNoise,
  isNoisyDir,
} from './lib.mjs';
import { withLock } from './lock.mjs';

const PRETTIER_CONFIG_CANDIDATES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.mjs',
];

// Bare trunk names, or a `prefix/slug` shape (feature/x, bugfix/y, hotfix/z).
const BRANCH_NAME_PATTERN = /^(main|master|develop|dev|trunk)$|^[a-z0-9][a-z0-9._-]*\/.+$/i;

const AGENTS_FILE = 'AGENTS.md';
const AUTO_START = '<!-- naso:auto:start -->';
const AUTO_END = '<!-- naso:auto:end -->';

/** NASO-managed files in the target repo. Not areas of the codebase. */
const BRIEFING_FILES = new Set([AGENTS_FILE, 'SETUP_INSTRUCTIONS.md']);

/** Beyond this, the auto-appended block is too big to stay a briefing aid. */
const AUTO_LINE_WARN_THRESHOLD = 40;

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', warn: 'WARN' }[status];
  console.log(`\n[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runStep(name, cmd, args, cwd) {
  console.log(`\n--- ${name}: running \`${cmd} ${args.join(' ')}\` ---`);
  const result = await run(cmd, args, { cwd, inherit: true });
  record(name, result.ok ? 'pass' : 'fail', result.ok ? undefined : `exit code ${result.code}`);
  return result.ok;
}

function printSummary() {
  console.log('\n## Summary\n');
  for (const r of results) {
    const icon = { pass: '✓', fail: '✗', skip: '—', warn: '!' }[r.status];
    console.log(`${icon} ${r.name}: ${r.status.toUpperCase()}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    if (warnings.length > 0) console.log(`\n${warnings.length} warning(s), none blocking.`);
    console.log('All blocking checks passed.');
    process.exitCode = 0;
  }
}

/**
 * Branch-naming check. Warn-only by design.
 *
 * A client's repository has its own convention and NASO cannot know it. A
 * blocking rule here does not teach a better branch name — it teaches
 * --no-verify, which then silently disables the secret checks too. The check
 * stays because it is cheap information, not because it gets to stop work.
 */
async function checkBranchName(cwd) {
  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!branchRes.ok) {
    record('Branch naming', 'skip', 'not a git repository');
    return;
  }
  const branch = branchRes.stdout.trim();
  if (branch === 'HEAD') {
    record('Branch naming', 'skip', 'detached HEAD');
  } else if (BRANCH_NAME_PATTERN.test(branch)) {
    record('Branch naming', 'pass', `\`${branch}\``);
  } else {
    console.log(
      `  ! \`${branch}\` does not match trunk names or a "prefix/slug" convention\n` +
        '    (e.g. feature/x, bugfix/y). Not blocking — this repo may use its own.',
    );
    record('Branch naming', 'warn', `\`${branch}\` — convention not recognised (not blocking)`);
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md: version freshness + one-line append for genuinely new paths
// ---------------------------------------------------------------------------

/** Read the `<!-- version: X -->` stamp bootstrap writes, or null if absent. */
function readBriefingVersion(content) {
  return content.match(/^<!--\s*version:\s*(.+?)\s*-->$/m)?.[1] ?? null;
}

/**
 * Brief the agent on the briefing's own health.
 *
 * Both findings are warnings, never failures. An agent needs to know the
 * briefing is stale or half-filled; it does not need its commit blocked over a
 * stale comment, and blocking here would push it toward --no-verify.
 */
async function checkBriefingVersion(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    record('AGENTS.md version', 'skip', 'no AGENTS.md in this repository');
    return null;
  }

  const content = await readFile(agentsPath, 'utf8').catch(() => '');
  const stamped = readBriefingVersion(content);
  if (!stamped) {
    record('AGENTS.md version', 'skip', 'no version stamp in AGENTS.md');
  } else {
    const current = await toolVersion();
    if (compareVersions(stamped, current) < 0) {
      console.log(
        `  ! AGENTS.md was generated by naso ${stamped}; this tool is ${current}. ` +
          'Run bootstrap.mjs --refresh to update the version stamp without losing the briefing.',
      );
      record('AGENTS.md version', 'pass', `${stamped} (outdated — bootstrap --refresh advised)`);
    } else {
      record('AGENTS.md version', 'pass', stamped);
    }
  }

  const remaining = countTodoMarkers(content);
  if (remaining > 0) {
    console.log(
      `  ! AGENTS.md still has ${remaining} unfilled TODO marker(s). ` +
        (await pathExists(path.join(cwd, 'SETUP_INSTRUCTIONS.md')))
          ? 'SETUP_INSTRUCTIONS.md is still present — the first agent has not finished setting up.'
          : 'Run check-briefing.mjs to see which sections are unfilled.',
    );
  }

  return content;
}

/**
 * Reduce staged additions to the units a briefing cares about: new top-level
 * directories, and new root-level files that signal something structural.
 * Files nested inside an area the briefing already covers are not news.
 */
export function notableAdditions(paths) {
  const units = new Set();
  for (const p of paths) {
    const segments = p.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    // The briefing describes the codebase; it is not part of the codebase.
    // Committing it would otherwise append a line about itself.
    if (segments.length === 1 && BRIEFING_FILES.has(segments[0])) continue;

    const [first, ...rest] = segments;
    if (rest.length > 0) {
      if (!isNoisyDir(first) && !first.startsWith('.')) units.add(`${first}/`);
      continue;
    }

    if (isRootNoise(first) || first.startsWith('.')) continue;
    units.add(first);
  }
  return Array.from(units).sort();
}

/**
 * What a path is about, guessed from its shape.
 *
 * Used only to prefix the one-line note validate appends for a newly-appeared
 * area. A wrong guess costs a human one edit of one line; a missing note costs
 * a briefing that quietly stops describing the repo. So the fallback is
 * "here is a new top-level area — describe it" rather than silence.
 */
export function describeUnit(unit) {
  const isDir = unit.endsWith('/');
  const name = isDir ? unit.slice(0, -1) : unit;

  if (/^(readme|changelog|contributing|license|licence|notice)$/i.test(name)) {
    return 'project documentation';
  }
  if (/^(docs?|documentation)$/i.test(name)) return 'documentation';
  if (/^(test|tests|__tests__|spec|specs|e2e|cypress|fixtures?)$/i.test(name)) {
    return 'tests';
  }
  if (/^(src|lib|app|apps|pkg|packages|internal|cmd|source)$/i.test(name)) {
    return 'application source';
  }
  if (/^(scripts?|tools?|bin|tooling)$/i.test(name)) return 'developer scripts';
  if (/^(infra|infrastructure|deploy|deployment|terraform|helm|k8s|docker)$/i.test(name)) {
    return 'infrastructure';
  }
  if (/^(config|configs|\.github|ci)$/i.test(name)) return 'configuration';
  if (/^(migrations?|db|database|schema|seed|seeds)$/i.test(name)) return 'data layer';
  if (isDir) return 'a new top-level area — describe what belongs here';
  return 'a new top-level file — describe its role';
}

/**
 * Should the append be staged automatically?
 *
 * Two conditions, both required. The file must be tracked — otherwise
 * `git add` would stage something the repository deliberately ignores, and in
 * the default excluded mode AGENTS.md is ignored on purpose. And it must have no
 * unstaged modifications at the moment of the append — staging it then would
 * sweep up a human's in-progress edits into a commit they did not write.
 */
async function shouldStageBriefing(cwd) {
  const tracked = await run('git', ['ls-files', '--error-unmatch', AGENTS_FILE], { cwd });
  if (!tracked.ok) return { stage: false, reason: 'not tracked by git' };

  const dirty = await run('git', ['diff', '--quiet', '--', AGENTS_FILE], { cwd });
  if (dirty.code !== 0) return { stage: false, reason: 'has unstaged edits' };

  return { stage: true, reason: null };
}

/**
 * Append one line per genuinely-new unit inside the auto block.
 *
 * "Genuinely new" means not already mentioned anywhere in the briefing, in any
 * form — a directory named in prose counts as covered. Never regenerates, never
 * rewrites a human's sentences, and never fails the commit: a briefing that
 * needs a human's attention gets a notice, not a block.
 */
async function appendBriefingNotes(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    record('AGENTS.md update', 'skip', 'no AGENTS.md in this repository');
    return;
  }

  const added = await run(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=A'],
    { cwd },
  );
  if (!added.ok) {
    record('AGENTS.md update', 'skip', 'could not read staged additions');
    return;
  }

  const additions = added.stdout.split('\n').filter(Boolean);
  if (additions.length === 0) {
    record('AGENTS.md update', 'skip', 'no newly added files in this commit');
    return;
  }

  const content = await readFile(agentsPath, 'utf8');
  if (!content.includes(AUTO_START) || !content.includes(AUTO_END)) {
    record('AGENTS.md update', 'skip', 'AGENTS.md has no naso:auto block');
    return;
  }

  const candidates = notableAdditions(additions);
  const missing = candidates.filter((unit) => !coversUnit(content, unit));
  if (missing.length === 0) {
    record('AGENTS.md update', 'pass', 'no new areas to note');
    return;
  }

  // Decide staging eligibility BEFORE the append. Afterwards the file is dirty
  // by definition — that is the edit we just made — so asking afterwards would
  // always answer "has unstaged edits" and never stage anything.
  const staging = await shouldStageBriefing(cwd);

  const outcome = await withLock(
    cwd,
    async () => {
      // Re-read under the lock: another writer may have appended in between.
      const fresh = await readFile(agentsPath, 'utf8');
      const stillMissing = missing.filter((unit) => !coversUnit(fresh, unit));
      if (stillMissing.length === 0) return { added: [], alreadyCovered: missing };

      const start = fresh.indexOf(AUTO_START) + AUTO_START.length;
      const end = fresh.indexOf(AUTO_END);
      if (start < AUTO_START.length || end === -1 || end < start) {
        return { added: [], malformed: true };
      }

      const existingLines = fresh
        .slice(start, end)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const note = (unit) => `- \`${unit}\` — TODO(describe): ${describeUnit(unit)}`;

      const appended = fresh.slice(0, start) + '\n' + stillMissing.map(note).join('\n') + '\n' + fresh.slice(end);
      await writeFile(agentsPath, appended, 'utf8');

      return {
        added: stillMissing,
        total: existingLines.length + stillMissing.length,
      };
    },
    {
      reason: 'append new-area notes to AGENTS.md',
      onBusy: (holder) => {
        console.log(`  ! ${AGENTS_FILE} is locked by ${holder}; skipped the update.`);
      },
    },
  );

  if (!outcome.ok) {
    record('AGENTS.md update', 'skip', `locked by ${outcome.holder}`);
    return;
  }

  const { added: appended, total, alreadyCovered, malformed } = outcome.value;
  if (malformed) {
    record('AGENTS.md update', 'skip', `malformed naso:auto block — fix by hand`);
    return;
  }
  if (appended.length === 0) {
    record('AGENTS.md update', 'pass', `${alreadyCovered.length} already covered`);
    return;
  }

  console.log(
    `\n  ${AGENTS_FILE}: noted ${appended.length} new area(s) under Project Structure:`,
  );
  for (const unit of appended) console.log(`    ${unit}`);
  console.log('  Each has a TODO(describe) — fill those in before committing.');

  // Stage the briefing so the note lands in the commit that introduced the
  // area, rather than being left behind as an unstaged modification the next
  // commit sweeps up by accident.
  if (staging.stage) {
    const add = await run('git', ['add', '--', AGENTS_FILE], { cwd });
    if (add.ok) {
      console.log(`  Staged ${AGENTS_FILE} so the note rides along with this commit.`);
    } else {
      console.log(`  Could not stage ${AGENTS_FILE}; the note is left unstaged.`);
    }
  } else {
    console.log(
      `  Left ${AGENTS_FILE} unstaged (${staging.reason}). The note is on disk but will not\n` +
        '  be part of this commit.',
    );
  }

  if (total > AUTO_LINE_WARN_THRESHOLD) {
    console.log(
      `  ! The auto block now holds ${total} lines. That is past ` +
        `${AUTO_LINE_WARN_THRESHOLD} — the briefing is describing files, not areas.\n` +
        '    Fold the entries into prose and prune the block.',
    );
  }

  record('AGENTS.md update', 'pass', `${appended.length} line(s) appended`);
}

async function runStaged(cwd, pkg, pm, { append }) {
  const stagedFiles = await getStagedFiles(cwd);

  await checkBranchName(cwd);

  const prettierConfigFiles = await allExisting(cwd, PRETTIER_CONFIG_CANDIDATES);
  const hasPrettierConfig = prettierConfigFiles.length > 0 || Boolean(pkg?.prettier);

  if (stagedFiles.length === 0) {
    record('Format', 'skip', 'no staged files');
    record('Lint', 'skip', 'no staged files');
  } else {
    if (hasPrettierConfig) {
      if (await hasLocalBin(cwd, 'prettier')) {
        const [cmd, args] = pmExecCommand(pm, 'prettier', [
          '--check',
          '--ignore-unknown',
          ...stagedFiles,
        ]);
        await runStep('Format', cmd, args, cwd);
      } else {
        record('Format', 'skip', 'prettier config present but prettier is not installed locally');
      }
    } else {
      record('Format', 'skip', 'no prettier configuration found');
    }

    const lintableFiles = stagedFiles.filter((f) =>
      /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/.test(f),
    );
    if (pkg?.scripts?.lint && (await hasLocalBin(cwd, 'eslint'))) {
      if (lintableFiles.length === 0) {
        record('Lint', 'skip', 'no staged files with a lintable extension');
      } else {
        const [cmd, args] = pmExecCommand(pm, 'eslint', lintableFiles);
        await runStep('Lint', cmd, args, cwd);
      }
    } else {
      record('Lint', 'skip', 'no "lint" script or eslint is not installed locally');
    }
  }

  await checkBriefingVersion(cwd);

  if (append) {
    await appendBriefingNotes(cwd);
  } else {
    record('AGENTS.md update', 'skip', '--no-append');
  }

  printSummary();
}

async function runFull(cwd, pkg, pm) {
  const scripts = pkg.scripts ?? {};

  if (scripts.lint) {
    const [cmd, args] = pmRunCommand(pm, 'lint');
    await runStep('Lint', cmd, args, cwd);
  } else {
    record('Lint', 'skip', 'no "lint" script in package.json');
  }

  // Prefer the project's own "typecheck" script — it may wrap tsc with
  // required pre-steps (codegen, migrations, ...). Fall back to a bare
  // `tsc --noEmit` only when the project hasn't defined one.
  const hasTsconfig = await pathExists(path.join(cwd, 'tsconfig.json'));
  if (scripts.typecheck) {
    const [cmd, args] = pmRunCommand(pm, 'typecheck');
    await runStep('TypeScript', cmd, args, cwd);
  } else if (hasTsconfig) {
    if (await hasLocalBin(cwd, 'tsc')) {
      const [cmd, args] = pmExecCommand(pm, 'tsc', ['--noEmit']);
      await runStep('TypeScript', cmd, args, cwd);
    } else {
      record('TypeScript', 'skip', 'tsconfig.json present but tsc is not installed locally');
    }
  } else {
    record('TypeScript', 'skip', 'no tsconfig.json');
  }

  if (scripts.test) {
    const [cmd, args] = pmRunCommand(pm, 'test');
    await runStep('Tests', cmd, args, cwd);
  } else {
    record('Tests', 'skip', 'no "test" script in package.json');
  }

  const prettierConfigFiles = await allExisting(cwd, PRETTIER_CONFIG_CANDIDATES);
  const hasPrettierConfig = prettierConfigFiles.length > 0 || Boolean(pkg.prettier);

  if (hasPrettierConfig) {
    if (await hasLocalBin(cwd, 'prettier')) {
      const [cmd, args] = pmExecCommand(pm, 'prettier', ['--check', '.']);
      await runStep('Format', cmd, args, cwd);
    } else {
      record('Format', 'skip', 'prettier config present but prettier is not installed locally');
    }
  } else {
    record('Format', 'skip', 'no prettier configuration found');
  }

  await checkBriefingVersion(cwd);

  printSummary();
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const staged = flags.has('staged');
  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso validate: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# NASO Validate (${staged ? 'staged' : 'full'}) — ${cwd}`);

  const pkg = await readJSONFile(path.join(cwd, 'package.json'));

  if (!pkg) {
    // No package.json: not a JS/TS project. The briefing and branch checks are
    // language-neutral, so they still run — they are the useful signal here.
    if (staged) {
      await checkBranchName(cwd);
      await checkBriefingVersion(cwd);
      if (flags.has('no-append')) {
        record('AGENTS.md update', 'skip', '--no-append');
      } else {
        await appendBriefingNotes(cwd);
      }
      record('Format', 'skip', 'no package.json — nothing to validate for a JS/TS project');
      record('Lint', 'skip', 'no package.json — nothing to validate for a JS/TS project');
      printSummary();
      return;
    }

    await checkBriefingVersion(cwd);
    console.log('\nNo package.json found — nothing to validate for a JS/TS project.');
    printSummary();
    return;
  }

  const pm = await detectPackageManager(cwd, pkg);

  if (staged) {
    await runStaged(cwd, pkg, pm, { append: !flags.has('no-append') });
  } else {
    await runFull(cwd, pkg, pm);
  }
}

main().catch((err) => {
  console.error(`naso validate: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
