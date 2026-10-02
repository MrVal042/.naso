#!/usr/bin/env node
// NASO Validate — the one mechanical gate, and the only thing the pre-commit
// hook runs.
//
// Two modes:
//
//   --staged   the hook. Secrets first (they block), then scope, then the
//              project's own format and lint on the staged files, then the
//              briefing's own health. Ordered by how expensive the failure is to
//              discover: a leaked key should be reported in milliseconds, not
//              after a lint run.
//   default    CI, or "am I done". Whole-project lint, typecheck, tests, format,
//              and the same secret rules over the working tree as warnings.
//
// Generic by design: it discovers the project's package manager, its scripts and
// its formatter from the repository itself. Nothing here assumes a language,
// framework, or directory layout.
//
// The secret rules used to live in a second script with a second hook line. One
// file means one thing to read, one thing to test, and no way for the secret
// check to end up behind a slow one.
//
// Usage:
//   npx naso-dev validate [dir] [--staged] [--no-append] [--strict]
//                           [--scope <prefix,prefix,...>]
// Env:
//   NASO_SCOPE=src,docs        prefixes a task owns
//   NASO_SCOPE_STRICT=1        refuse the commit on an out-of-scope path
//
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
  parseGitStatusPorcelain,
  parseArgs,
  run,
  scanStagedContent,
  compareVersions,
  toolVersion,
  coversUnit,
  isRootNoise,
  isNoisyDir,
  isMainModule,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { withLock } from './lock.mjs';
import { scanRepo, lineForUnit } from './briefing.mjs';

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

// ---------------------------------------------------------------------------
// Secret rules
// ---------------------------------------------------------------------------

const ENV_FILE = /(^|\/)\.env($|[./_-])/i;
const SENSITIVE_EXT = /\.(pem|p12|pfx|key)$/i;
const COMPOUND = /(service[-_]?role|private[-_]?key|secret[-_]?key|api[-_]?key|access[-_]?key|jwt[-_]?secret)/i;
const SSH_KEY = /(^|\/)id_(rsa|ed25519)/i;

/** Exact path segments that mean "this is a secret store". */
const SECRET_SEGMENTS = new Set(['secret', 'secrets', 'credential', 'credentials']);

/** `.env.example` and friends are committed on purpose and hold no values. */
const ENV_ALLOWLIST = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

/** Rules that refuse a commit. Everything else is information, not an obstacle. */
const BLOCKING_SECRET_RULES = new Set(['ENV_FILE', 'SENSITIVE_EXT', 'SSH_KEY', 'SECRET_CONTENT']);

const basename = (p) => p.split('/').at(-1) ?? p;

function isEnvAllowlisted(p) {
  return ENV_ALLOWLIST.has(basename(p).toLowerCase());
}

/** Split on / - _ . so `app-secret-store` yields ['app','secret','store']. */
function segments(p) {
  return p.toLowerCase().split(/[/._-]+/).filter(Boolean);
}

/**
 * Classify one path against the secret rules.
 *
 * The narrow set is deliberate. Earlier versions used broad `.*token.*` /
 * `.*key.*` substrings, which flagged roughly one file in four — including
 * `design-tokens/x.ts` and `src/keyboard/y.ts` — and a rule that fires that often
 * teaches an agent to ignore the output, which costs you every real finding too.
 */
export function classifySecretPath(p) {
  const hits = [];
  const lower = basename(p).toLowerCase();

  if (ENV_FILE.test(p) && !isEnvAllowlisted(p)) hits.push('ENV_FILE');
  if (SENSITIVE_EXT.test(p)) hits.push('SENSITIVE_EXT');
  if (SSH_KEY.test(p)) hits.push('SSH_KEY');
  // COMPOUND and SECRET_SEG are warn-only: a suspicious name, not a certain leak.
  if (COMPOUND.test(lower) || COMPOUND.test(p)) hits.push('COMPOUND');
  if (segments(p).some((seg) => SECRET_SEGMENTS.has(seg))) hits.push('SECRET_SEG');

  return [...new Set(hits)].filter((rule) => !(isEnvAllowlisted(p) && rule === 'ENV_FILE'));
}

// ---------------------------------------------------------------------------
// Non-secret path rules
// ---------------------------------------------------------------------------

const GENERATED_DIR_PATTERN =
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.output|\.turbo|\.svelte-kit|\.angular|vendor|__pycache__|target)(\/|$)/i;

const DEPENDENCY_DIR_PATTERN =
  /(^|\/)(node_modules|vendor|bower_components|\.venv|venv|\.tox|\.gradle)(\/|$)/i;

const SOURCE_MAP_PATTERN = /\.map$/i;

const DEPENDENCY_FILE_PATTERN =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|Pipfile|Pipfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle|build\.gradle\.kts|Podfile|Podfile\.lock)$/i;

/** Warnings, in the order they are worth reading. */
const WARNS = [
  {
    title: 'Secret-shaped paths changed (name only — check before committing)',
    next: 'Confirm these are placeholders or names, not live values. Real secrets belong in a deployment secret store.',
    match: (p) => ['COMPOUND', 'SECRET_SEG'].some((r) => classifySecretPath(p).includes(r)),
  },
  {
    title: 'Generated, build-output or installed-dependency paths changed',
    next: 'Do not commit generated output or installed dependencies unless this repository tracks them on purpose.',
    match: (p) =>
      GENERATED_DIR_PATTERN.test(p) || DEPENDENCY_DIR_PATTERN.test(p) || SOURCE_MAP_PATTERN.test(p),
  },
  {
    title: 'Dependency manifest or lockfile changed',
    next: 'Confirm dependency changes are intentional before committing.',
    match: (p) => DEPENDENCY_FILE_PATTERN.test(p),
  },
];

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Files always inside scope, whatever NASO_SCOPE says. */
const SCOPE_ALWAYS_ALLOWED = new Set([AGENTS_FILE, '.naso.lock', 'SETUP_INSTRUCTIONS.md']);

/**
 * Resolve scope prefixes from --scope or NASO_SCOPE.
 * Returns null when no scope is configured, meaning "do not check".
 */
export function resolveScope(flagValue, envValue) {
  const raw = flagValue ?? envValue;
  if (!raw) return null;
  const prefixes = raw
    .split(',')
    .map((p) => p.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
  return prefixes.length > 0 ? prefixes : null;
}

/** Is `p` inside at least one scope prefix? */
export function inScope(p, prefixes) {
  const normalized = p.replace(/\\/g, '/');
  return prefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function outOfScopePaths(paths, prefixes) {
  return paths
    .filter((p) => !inScope(p, prefixes))
    .filter((p) => !SCOPE_ALWAYS_ALLOWED.has(basename(p)))
    .sort();
}

// ---------------------------------------------------------------------------
// Briefing upkeep
// ---------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Reduce staged additions to the units a briefing cares about: new top-level
 * directories, and new root-level files that signal something structural.
 * Files nested inside an area the briefing already covers are not news.
 */
export function notableAdditions(paths) {
  const units = new Set();
  for (const p of paths) {
    const segments_ = p.split('/').filter(Boolean);
    if (segments_.length === 0) continue;

    // The briefing describes the codebase; it is not part of the codebase.
    // Committing it would otherwise append a line about itself.
    if (segments_.length === 1 && BRIEFING_FILES.has(segments_[0])) continue;

    const [first, ...rest] = segments_;
    if (rest.length > 0) {
      if (!isNoisyDir(first) && !first.startsWith('.')) units.add(`${first}/`);
      continue;
    }

    if (isRootNoise(first) || first.startsWith('.')) continue;
    units.add(first);
  }
  return Array.from(units).sort();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];

function record(name, kind, detail) {
  results.push({ name, kind, detail });
  const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', warn: 'WARN' }[kind] ?? 'INFO';
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function printSummary() {
  console.log('\n## Summary\n');
  for (const r of results) {
    const icon = { pass: '+', fail: 'x', skip: '-', warn: '!' }[r.kind] ?? ' ';
    console.log(`${icon} ${r.name}: ${r.kind.toUpperCase()}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const failures = results.filter((r) => r.kind === 'fail');
  const warnings = results.filter((r) => r.kind === 'warn');
  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    if (warnings.length > 0) console.log(`\n${warnings.length} warning(s), none blocking.`);
    console.log('All blocking checks passed.');
    process.exitCode = 0;
  }
}

async function runStep(name, cmd, args, cwd) {
  console.log(`\n--- ${name}: running \`${cmd} ${args.join(' ')}\` ---`);
  const result = await run(cmd, args, { cwd, inherit: true });
  record(name, result.ok ? 'pass' : 'fail', result.ok ? undefined : `exit code ${result.code}`);
  return result.ok;
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------

/**
 * Secret rules over a set of changed paths, blocking tier only.
 *
 * Findings report path, line and rule name only — never the matched text — so a
 * warning is safe to paste into a chat, a CI log, or a bug report.
 */
async function scanSecrets(cwd, paths, staged) {
  const blocks = [];

  if (!staged) return { blocks };

  for (const p of paths) {
    for (const rule of classifySecretPath(p)) {
      if (BLOCKING_SECRET_RULES.has(rule)) blocks.push({ path: p, rule });
    }
  }

  for (const hit of await scanStagedContent(cwd)) {
    blocks.push({ path: hit.path, rule: hit.rule, line: hit.line });
  }

  return { blocks };
}

/** The warn-only path rules, grouped for display. */
async function secretWarnings(paths) {
  const matched = [];
  for (const guidance of WARNS) {
    const files = Array.from(new Set(paths.filter(guidance.match))).sort();
    if (files.length > 0) matched.push({ guidance, files });
  }
  return matched;
}

/** The paths this run should look at: staged files, or the working tree. */
async function changedPaths(cwd, staged) {
  if (staged) return getStagedFiles(cwd);

  const res = await run('git', ['status', '--porcelain'], { cwd });
  if (!res.ok) return null;
  return parseGitStatusPorcelain(res.stdout).map((entry) => entry.path);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Branch-naming check. Warn-only by design.
 *
 * A client's repository has its own convention and NASO cannot know it. A
 * blocking rule here does not teach a better branch name — it teaches bypassing
 * the hook, which then silently disables the secret checks too. The check stays
 * because it is cheap information, not because it gets to stop work.
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
    record('Branch naming', 'pass', branch);
  } else {
    console.log(
      `  ! ${branch} matches neither a trunk name nor a prefix/slug convention\n` +
        '    (e.g. feature/x, bugfix/y). Not blocking — this repo may use its own.',
    );
    record('Branch naming', 'warn', `${branch} — convention not recognised (not blocking)`);
  }
}

/** The `<!-- version: X -->` stamp, or null when there is none. */
export function readBriefingVersion(content) {
  return content.match(/^<!--\s*version:\s*(.+?)\s*-->$/m)?.[1] ?? null;
}

/**
 * Brief the agent on the briefing's own health. Both findings are warnings.
 *
 * An agent needs to know its briefing is stale or half-written; it does not need
 * its commit blocked over a stale comment, and blocking there pushes it toward
 * bypassing the hook entirely.
 */
async function checkBriefingHealth(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    record('AGENTS.md', 'skip', 'no briefing in this repository — run `npx naso-dev setup` to create one');
    return null;
  }

  const content = await readFile(agentsPath, 'utf8').catch(() => '');
  const stamped = readBriefingVersion(content);

  if (!stamped) {
    record('AGENTS.md version', 'skip', 'no version stamp');
  } else {
    const current = await toolVersion();
    // Three cases, not two. A stamp *newer* than the tool is the only one that
    // means the tool is wrong, and telling someone to "update" for a briefing they
    // just wrote would send them the wrong way. Only a stamp older than the tool
    // is a briefing that is behind, and only that one is worth refreshing.
    const order = compareVersions(stamped, current);
    if (order < 0) {
      console.log(
        `  ! AGENTS.md was generated by NASO ${stamped}; this tool is ${current}. ` +
          'Run `npx naso-dev briefing refresh` to move the stamp without losing the briefing.',
      );
      record('AGENTS.md version', 'warn', `${stamped} — behind ${current}, refresh advised`);
    } else if (order > 0) {
      console.log(
        `  ! AGENTS.md was generated by NASO ${stamped}; this tool is ${current}. ` +
          'The briefing is ahead of the tool — update naso-dev rather than downgrading the file.',
      );
      record('AGENTS.md version', 'warn', `${stamped} — newer than ${current}, update naso-dev`);
    } else {
      record('AGENTS.md version', 'pass', stamped);
    }
  }

  const unfilled = (content.match(/TODO\((fill|describe)\)/g) ?? []).length;
  if (unfilled > 0) {
    console.log(
      `  ! AGENTS.md still carries ${unfilled} placeholder marker(s). ` +
        'Regenerate it with `npx naso-dev briefing create --force`, or fix the lines by hand.',
    );
    record('AGENTS.md placeholders', 'warn', `${unfilled} remaining`);
  }

  return content;
}

/**
 * Should the append be staged automatically?
 *
 * Two conditions, both required. The file must be tracked — otherwise `git add`
 * would stage something the repository deliberately ignores, and in the default
 * excluded mode AGENTS.md is ignored on purpose. And it must have no unstaged
 * modifications — staging it then would sweep a human's in-progress edits into a
 * commit they did not write.
 */
async function shouldStageBriefing(cwd) {
  const tracked = await run('git', ['ls-files', '--error-unmatch', AGENTS_FILE], { cwd });
  if (!tracked.ok) return { stage: false, reason: 'not tracked by git' };

  const dirty = await run('git', ['diff', '--quiet', '--', AGENTS_FILE], { cwd });
  if (dirty.code !== 0) return { stage: false, reason: 'it has unstaged edits' };

  return { stage: true, reason: null };
}

/**
 * Append one line per genuinely-new area inside the auto block.
 *
 * "Genuinely new" means not mentioned anywhere in the briefing, in any form — a
 * directory named in prose counts as covered. Never regenerates, never rewrites
 * a human's sentences, and never fails the commit: a briefing that needs a
 * human's attention gets a notice, not a block.
 */
async function appendBriefingNotes(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    record('AGENTS.md update', 'skip', 'no briefing in this repository');
    return;
  }

  const added = await run('git', ['diff', '--cached', '--name-only', '--diff-filter=A'], { cwd });
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

  // Decide staging eligibility BEFORE the append. Afterwards the file is dirty by
  // definition — that is the edit we just made — so asking afterwards would always
  // answer "has unstaged edits" and never stage anything.
  const staging = await shouldStageBriefing(cwd);

  // Rendered outside the lock: a scan reads, and holding an exclusive lock across
  // a whole-repository read would serialise unrelated commits for no benefit. A
  // failed scan degrades to a name-based description rather than failing a commit.
  const facts = await scanRepo(cwd).catch(() => null);

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

      const rendered = stillMissing.map((unit) => lineForUnit(unit, facts)).join('\n');
      const appended =
        fresh.slice(0, start) + '\n' + rendered + '\n' + fresh.slice(end);
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
    record('AGENTS.md update', 'skip', 'malformed naso:auto block — fix by hand');
    return;
  }
  if (appended.length === 0) {
    record('AGENTS.md update', 'pass', `${alreadyCovered.length} already covered`);
    return;
  }

  console.log(`\n  ${AGENTS_FILE}: noted ${appended.length} new area(s) under Project Structure:`);
  for (const unit of appended) console.log(`    ${unit}`);

  // Stage the briefing so the note lands in the commit that introduced the area,
  // rather than being left behind as an unstaged modification the next commit
  // sweeps up by accident.
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
      `  ! The auto block now holds ${total} lines, past ${AUTO_LINE_WARN_THRESHOLD}. That is a\n` +
        '    file inventory rather than a briefing. Fold the entries into prose and prune it.',
    );
  }

  record('AGENTS.md update', 'pass', `${appended.length} line(s) appended`);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runSecrets(cwd, staged, prefixes, strictScope) {
  const paths = await changedPaths(cwd, staged);

  if (paths === null) {
    record('Secrets', 'fail', 'could not read git status — is this a git repository?');
    return false;
  }

  const { blocks } = await scanSecrets(cwd, paths, staged);

  if (blocks.length > 0) {
    console.log('## BLOCKING — high-confidence secret rule match\n');
    for (const b of blocks) {
      console.log(`- ${b.line ? `${b.path}:${b.line}` : b.path}  ${b.rule}`);
    }
    console.log(
      'Next: unstage the file and move the value to a deployment secret store.\n' +
        '      Path and rule only are shown; the matched text is never printed.\n',
    );
    record('Secrets', 'fail', `${blocks.length} blocking finding(s)`);
  } else {
    record('Secrets', 'pass', `${plural(paths.length, 'path')} checked`);
  }

  for (const { guidance, files } of await secretWarnings(paths)) {
    console.log(`\n## ${guidance.title}`);
    for (const file of files) console.log(`- ${file}`);
    console.log(`Next: ${guidance.next}\n`);
    record(guidance.title, 'warn', `${files.length} path(s)`);
  }

  const outside = prefixes ? outOfScopePaths(paths, prefixes) : [];
  if (outside.length > 0) {
    console.log('## Out-of-scope paths changed');
    for (const file of outside) console.log(`- ${file}`);
    console.log(
      `Next: only paths under ${prefixes.join(', ')} were in scope. Split unrelated work into ` +
        'its own commit.\n',
    );
    if (strictScope) {
      record('Scope', 'fail', `${outside.length} out-of-scope path(s), strict scope is on`);
    } else {
      record('Scope', 'warn', `${outside.length} out-of-scope path(s) (warn-only)`);
    }
  } else if (prefixes) {
    record('Scope', 'pass', `everything changed is under ${prefixes.join(', ')}`);
  } else {
    record('Scope', 'skip', 'no scope configured — set NASO_SCOPE to enable this check');
  }

  return blocks.length === 0 && !(outside.length > 0 && strictScope);
}

async function runStaged(cwd, pkg, pm, { append, prefixes, strictScope }) {
  // Secrets and scope first: they are the findings a person must act on before
  // anything else, and running them first means a leaked key is reported before
  // a slow lint has a chance to bury it.
  const secretsOk = await runSecrets(cwd, true, prefixes, strictScope);

  const stagedFiles = await getStagedFiles(cwd);

  if (stagedFiles.length === 0) {
    record('Format', 'skip', 'no staged files');
    record('Lint', 'skip', 'no staged files');
  } else {
    const hasPrettier =
      (await allExisting(cwd, PRETTIER_CONFIG_CANDIDATES)).length > 0 || Boolean(pkg?.prettier);

    if (!hasPrettier) {
      record('Format', 'skip', 'no prettier configuration found');
    } else if (!(await hasLocalBin(cwd, 'prettier'))) {
      record('Format', 'skip', 'prettier is configured but not installed locally');
    } else {
      const [cmd, args] = pmExecCommand(pm, 'prettier', [
        '--check',
        '--ignore-unknown',
        ...stagedFiles,
      ]);
      await runStep('Format', cmd, args, cwd);
    }

    const lintable = stagedFiles.filter((f) => /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/.test(f));
    if (!pkg?.scripts?.lint || !(await hasLocalBin(cwd, 'eslint'))) {
      record('Lint', 'skip', 'no "lint" script or eslint is not installed locally');
    } else if (lintable.length === 0) {
      record('Lint', 'skip', 'no staged files with a lintable extension');
    } else {
      const [cmd, args] = pmExecCommand(pm, 'eslint', lintable);
      await runStep('Lint', cmd, args, cwd);
    }
  }

  await checkBranchName(cwd);
  await checkBriefingHealth(cwd);

  if (append) {
    await appendBriefingNotes(cwd);
  } else {
    record('AGENTS.md update', 'skip', '--no-append');
  }

  void secretsOk;
  printSummary();
}

async function runFull(cwd, pkg, pm) {
  const scripts = pkg.scripts ?? {};
  const prefixes = resolveScope(null, process.env.NASO_SCOPE);
  const strictScope = process.env.NASO_SCOPE_STRICT === '1';

  await runSecrets(cwd, false, prefixes, strictScope);

  if (scripts.lint) {
    const [cmd, args] = pmRunCommand(pm, 'lint');
    await runStep('Lint', cmd, args, cwd);
  } else {
    record('Lint', 'skip', 'no "lint" script in package.json');
  }

  // Prefer the project's own "typecheck" script — it may wrap tsc with required
  // pre-steps (codegen, migrations). Fall back to a bare `tsc --noEmit` only when
  // the project has not defined one.
  const hasTsconfig = await pathExists(path.join(cwd, 'tsconfig.json'));
  if (scripts.typecheck) {
    const [cmd, args] = pmRunCommand(pm, 'typecheck');
    await runStep('TypeScript', cmd, args, cwd);
  } else if (hasTsconfig && (await hasLocalBin(cwd, 'tsc'))) {
    const [cmd, args] = pmExecCommand(pm, 'tsc', ['--noEmit']);
    await runStep('TypeScript', cmd, args, cwd);
  } else {
    record('TypeScript', 'skip', hasTsconfig ? 'tsc is not installed locally' : 'no tsconfig.json');
  }

  if (scripts.test) {
    const [cmd, args] = pmRunCommand(pm, 'test');
    await runStep('Tests', cmd, args, cwd);
  } else {
    record('Tests', 'skip', 'no "test" script in package.json');
  }

  const hasPrettier =
    (await allExisting(cwd, PRETTIER_CONFIG_CANDIDATES)).length > 0 || Boolean(pkg.prettier);
  if (!hasPrettier) {
    record('Format', 'skip', 'no prettier configuration found');
  } else if (!(await hasLocalBin(cwd, 'prettier'))) {
    record('Format', 'skip', 'prettier is configured but not installed locally');
  } else {
    const [cmd, args] = pmExecCommand(pm, 'prettier', ['--check', '.']);
    await runStep('Format', cmd, args, cwd);
  }

  await checkBriefingHealth(cwd);

  printSummary();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`NASO validate

Usage:
  npx naso-dev validate [dir]                          full run: secrets, lint, types, tests, format
  npx naso-dev validate [dir] --staged                  the pre-commit gate
  npx naso-dev validate [dir] --staged --no-append      same, without touching AGENTS.md
  npx naso-dev validate [dir] --scope src,docs          refuse work outside those prefixes
  npx naso-dev validate [dir] --strict                  turn scope warnings into a refusal

Environment:
  NASO_SCOPE=src,docs         same as --scope
  NASO_SCOPE_STRICT=1         same as --strict

Exit codes: 0 all blocking checks passed, 1 otherwise.
Support: ${SUPPORT_EMAIL}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }

  const staged = flags.has('staged');
  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev validate: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const prefixes = resolveScope(values.get('scope') ?? null, process.env.NASO_SCOPE);
  const strictScope = flags.has('strict') || process.env.NASO_SCOPE_STRICT === '1';

  console.log(`# NASO Validate (${staged ? 'staged' : 'full'}) — ${cwd}`);
  console.log(`Scope: ${prefixes ? prefixes.join(', ') : 'not set (scope check skipped)'}\n`);

  const pkg = await readJSONFile(path.join(cwd, 'package.json'));

  if (!pkg) {
    // No package.json: not a JS/TS project. The secret, scope and briefing checks
    // are language-neutral, so they still run — they are the useful signal here.
    if (staged) {
      await runSecrets(cwd, true, prefixes, strictScope);
      record('Format', 'skip', 'no package.json — nothing to validate for a JS/TS project');
      record('Lint', 'skip', 'no package.json — nothing to validate for a JS/TS project');
      await checkBranchName(cwd);
      await checkBriefingHealth(cwd);
      if (flags.has('no-append')) {
        record('AGENTS.md update', 'skip', '--no-append');
      } else {
        await appendBriefingNotes(cwd);
      }
    } else {
      await runSecrets(cwd, false, prefixes, strictScope);
      await checkBriefingHealth(cwd);
      console.log('\nNo package.json found — nothing to validate for a JS/TS project.');
    }
    printSummary();
    return;
  }

  const pm = await detectPackageManager(cwd, pkg);

  if (staged) {
    await runStaged(cwd, pkg, pm, {
      append: !flags.has('no-append'),
      prefixes,
      strictScope,
    });
  } else {
    await runFull(cwd, pkg, pm);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev validate: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
