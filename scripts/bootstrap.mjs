#!/usr/bin/env node
// NASO Bootstrap — gives a target repository a project-specific AGENTS.md
// briefing and a pre-commit hook that runs the NASO guards.
//
// Two files land in the target:
//   AGENTS.md             the briefing template, with a version stamp and an
//                         ownership line so later edits go through code review
//   SETUP_INSTRUCTIONS.md  a one-time guide telling the first agent that reads
//                         the repo to fill the template in from the real code,
//                         self-check every path it claims, and get a human to
//                         confirm before treating it as truth
//
// Plus, unless --no-hook: .git/hooks/pre-commit running guard.mjs and
// validate.mjs against staged files.
//
// --refresh is the safe way to catch a bootstrapped repo up to a newer tool
// version: it rewrites the `<!-- version: -->` stamp and nothing else, so a
// briefing an agent already filled in survives. --force is the destructive
// one and says so.
//
// By default the two briefing files are kept out of the target's git tracking
// via .git/info/exclude — a local-only file that is never committed — so
// bootstrapping a client or contract repository leaves no trace in its history.
// Pass --track to have them committed instead.
//
// Usage:
//   node .naso/scripts/bootstrap.mjs [target-dir] [options]
//     --force      overwrite an existing AGENTS.md with a fresh template
//     --refresh    bump only the version stamp on an existing AGENTS.md and
//                  refresh the hook; never touches briefing content
//     --no-hook    skip installing the pre-commit hook
//     --track      let the briefing files be git-tracked instead of excluded
//
// Zero external dependencies — Node.js core modules only.

import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  parseArgs,
  actorIdentity,
  toolVersion,
  shellSingleQuote,
  toPosixPath,
  run,
  nasoDir,
} from './lib.mjs';
import { chmod } from 'node:fs/promises';

const HOOK_MARKER = '# managed-by: naso bootstrap';
const EXCLUDE_MARKER = '# added by naso bootstrap';

/** Files bootstrap may create in the target repo. */
const BRIEFING_FILES = ['AGENTS.md', 'SETUP_INSTRUCTIONS.md'];

/** Where the naso tool directory lives relative to this script. */
function toolDir() {
  return nasoDir();
}

/** Read a file from the tool directory. */
async function readToolFile(name) {
  const file = path.join(toolDir(), name);
  return readFile(file, 'utf8');
}

/**
 * Render the briefing template with its version stamp and ownership line.
 *
 * The template ships two TODO markers for exactly this: the machine-readable
 * HTML comments at the top, and the human-readable "Bootstrapped by..." block
 * quote. Filling both is what lets validate.mjs later compare versions and let
 * a reader see who to ask when a claim turns out to be wrong.
 */
function renderBriefing(template, version, actor, now) {
  return template
    .replace('<!-- version: TODO(fill): current naso version -->', `<!-- version: ${version} -->`)
    .replace('<!-- bootstrapped-by: TODO(fill): who ran bootstrap.mjs -->', `<!-- bootstrapped-by: ${actor} -->`)
    .replace('<!-- bootstrapped-at: TODO(fill): ISO date -->', `<!-- bootstrapped-at: ${now} -->`)
    .replace(
      '> Bootstrapped by TODO(fill): who, on TODO(fill): when.',
      `> Bootstrapped by ${actor} on ${now}.`,
    );
}

/** Write a file unless it exists and --force wasn't passed. */
async function writeFileUnlessPresent(filePath, content, force, label, warnOnOverwrite) {
  if ((await pathExists(filePath)) && !force) {
    console.log(`- Skipped ${label}: ${filePath} already exists. Pass --force to overwrite.`);
    return false;
  }
  if (force && warnOnOverwrite && (await pathExists(filePath))) {
    console.log(
      '  ! --force overwrites AGENTS.md with an empty template, discarding the briefing.\n' +
        '    Use --refresh to bump the version stamp without losing the content.',
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  console.log(`- Wrote ${label}: ${filePath}`);
  return true;
}

/**
 * Bump only the `<!-- version: X -->` stamp on an existing AGENTS.md.
 *
 * This is the whole point of --refresh. A briefing that took an agent twenty
 * minutes of reading the codebase to produce is irreplaceable; a stale version
 * stamp is a one-line cosmetic difference. Never regenerate the template here,
 * and never touch SETUP_INSTRUCTIONS.md — re-running the setup flow over a
 * confirmed briefing would send the next agent back to fill in work that is
 * already done.
 */
async function refreshBriefingStamp(agentsPath, version) {
  const content = await readFile(agentsPath, 'utf8');
  const stamped = content.match(/^<!--\s*version:\s*(.+?)\s*-->$/m)?.[1] ?? null;

  if (!stamped) {
    console.log(
      `- Skipped AGENTS.md: no version stamp found in ${agentsPath}.\n` +
        '  Nothing was changed. To regenerate the whole file, re-run without --refresh.',
    );
    return false;
  }

  if (stamped === version) {
    console.log(`- AGENTS.md is already stamped ${version} — nothing to refresh.`);
    return false;
  }

  const updated = content.replace(
    /^<!--\s*version:\s*.+?\s*-->$/m,
    `<!-- version: ${version} -->`,
  );
  await writeFile(agentsPath, updated, 'utf8');
  console.log(`- Refreshed AGENTS.md version stamp: ${stamped} -> ${version}`);
  console.log('  Briefing content untouched.');
  return true;
}

/**
 * Build the pre-commit hook body.
 *
 * Cross-platform notes, since this is the one part that genuinely differs:
 * Git for Windows executes hooks through its bundled POSIX `sh`, so a
 * `#!/bin/sh` script is correct on both platforms and needs no .cmd variant.
 * What does differ is path handling — Windows paths carry spaces and `C:\`
 * prefixes, so every interpolated path is converted to forward slashes and
 * wrapped in single quotes before it reaches the shell body.
 */
function buildHookScript(validateScriptPath, guardScriptPath) {
  const guard = toPosixPath(guardScriptPath);
  const validate = toPosixPath(validateScriptPath);
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by .naso/scripts/bootstrap.mjs — runs NASO checks before each commit.
# Remove or edit this file freely; it will not be silently overwritten.

# Resolve node: hooks inherit a minimal PATH on some systems, so fall back to
# the common install locations rather than failing with "command not found".
if command -v node >/dev/null 2>&1; then
  NODE_BIN=node
elif [ -x "/c/Program Files/nodejs/node.exe" ]; then
  NODE_BIN="/c/Program Files/nodejs/node.exe"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
else
  echo "naso: node not found in PATH — skipping pre-commit checks." >&2
  exit 0
fi

# Guard: BLOCKS on high-confidence secret rules (.env, .pem/.p12/.pfx/.key,
# id_rsa*/id_ed25519*, and content-scan hits on added lines). Warn-only for
# compound secret names, generated output, dependency files, and scope.
#
# NASO_SCOPE / NASO_SCOPE_STRICT pass through the environment automatically, so
# an agent that exported the owning path prefixes gets the diff checked against
# them with no extra hook wiring.
"$NODE_BIN" ${shellSingleQuote(guard)} --staged
GUARD_STATUS=$?

# Only stop on the guard's own failure — never on a bare "findings found".
if [ $GUARD_STATUS -ne 0 ]; then
  echo "naso: blocking guard finding — commit refused." >&2
  exit $GUARD_STATUS
fi

# Validate: staged format, lint, AGENTS.md freshness and the one-line briefing
# append. Branch naming is reported here but no longer blocks.
"$NODE_BIN" ${shellSingleQuote(validate)} --staged
exit $?
`;
}

/**
 * Locate the hooks directory for a repository.
 *
 * `git rev-parse --git-path hooks` is the only correct answer across all of:
 * plain clones, linked worktrees (where `.git` is a *file*, not a directory),
 * and repos that override `core.hooksPath`.
 */
async function resolveHooksDir(targetDir) {
  const res = await run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: targetDir });
  if (!res.ok) return null;
  const raw = res.stdout.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(targetDir, raw);
}

async function installPreCommitHook(targetDir, validateScriptPath, guardScriptPath) {
  const hooksDir = await resolveHooksDir(targetDir);
  if (!hooksDir) {
    console.log('- Skipped git hook: target is not a git repository.');
    console.log(`  To install it later, add these lines to .git/hooks/pre-commit:`);
    console.log(`    node ${shellSingleQuote(toPosixPath(guardScriptPath))} --staged`);
    console.log(`    node ${shellSingleQuote(toPosixPath(validateScriptPath))} --staged`);
    return;
  }

  const hookPath = path.join(hooksDir, 'pre-commit');

  if (await pathExists(hookPath)) {
    const existing = await readFile(hookPath, 'utf8').catch(() => '');
    if (!existing.includes(HOOK_MARKER)) {
      console.log(`- Skipped git hook: ${hookPath} exists and was not created by NASO.`);
      console.log(`  To run NASO checks, add these lines to it:`);
      console.log(`    node ${shellSingleQuote(toPosixPath(guardScriptPath))} --staged`);
      console.log(`    node ${shellSingleQuote(toPosixPath(validateScriptPath))} --staged`);
      return;
    }
  }

  await mkdir(hooksDir, { recursive: true });
  // No BOM and LF endings: Git for Windows runs this through `sh`, and a BOM
  // would make the shebang unrecognizable while CRLF would break it outright.
  const body = buildHookScript(validateScriptPath, guardScriptPath);
  await writeFile(hookPath, body, 'utf8');
  // No-op on Windows filesystems, harmless there; on POSIX this is what makes
  // the hook executable.
  await chmod(hookPath, 0o755).catch(() => {});
  console.log(`- Installed pre-commit hook: ${hookPath}`);
}

/** Add patterns to .git/info/exclude (local-only, never committed) if absent. */
async function excludeLocally(targetDir, patterns) {
  const gitDirRes = await run('git', ['rev-parse', '--git-dir'], { cwd: targetDir });
  if (!gitDirRes.ok) return false;

  const gitDirRaw = gitDirRes.stdout.trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(targetDir, gitDirRaw);
  const excludeDir = path.join(gitDir, 'info');
  const excludePath = path.join(excludeDir, 'exclude');
  const existing = await readFile(excludePath, 'utf8').catch(() => '');

  const missing = patterns.filter((pattern) => !existing.includes(pattern));
  if (missing.length === 0) return true;

  await mkdir(excludeDir, { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(excludePath, `${prefix}\n${EXCLUDE_MARKER}\n${missing.join('\n')}\n`, 'utf8');
  return true;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  let force = flags.has('force');
  const refresh = flags.has('refresh');
  const noHook = flags.has('no-hook');
  const track = flags.has('track');

  const targetDir = path.resolve(positional[0] ?? process.cwd());
  const toolDirectory = toolDir();
  const validateScriptPath = path.join(toolDirectory, 'scripts', 'validate.mjs');
  const guardScriptPath = path.join(toolDirectory, 'scripts', 'guard.mjs');

  if (!(await pathExists(targetDir))) {
    console.error(`naso bootstrap: target directory does not exist: ${targetDir}`);
    process.exitCode = 1;
    return;
  }

  const version = await toolVersion();
  const actor = actorIdentity();
  const now = new Date().toISOString().slice(0, 10);

  console.log(`# NASO Bootstrap ${version} — ${targetDir}`);
  console.log(`\nTool directory: ${toolDirectory}`);
  console.log(`Bootstrapped by: ${actor} on ${now}`);
  console.log();

  if (force && refresh) {
    console.log('  ! Both --force and --refresh passed; --refresh takes precedence and');
    console.log('    nothing in AGENTS.md will be overwritten.\n');
    force = false;
  }

  if (refresh) {
    // --refresh is the catch-up path, not the setup path: stamp and hook only.
    const agentsPath = path.join(targetDir, 'AGENTS.md');
    if (!(await pathExists(agentsPath))) {
      console.log(
        `- No AGENTS.md in ${targetDir} yet. Run without --refresh to bootstrap it.`,
      );
    } else {
      await refreshBriefingStamp(agentsPath, version);
    }

    if (!noHook) {
      console.log();
      await installPreCommitHook(targetDir, validateScriptPath, guardScriptPath);
    }

    console.log('\nDone.');
    return;
  }

  const template = await readToolFile('AGENTS.template.md');
  const setupInstructions = await readToolFile('SETUP_INSTRUCTIONS.md');

  const agentsPath = path.join(targetDir, 'AGENTS.md');
  await writeFileUnlessPresent(
    agentsPath,
    renderBriefing(template, version, actor, now),
    force,
    'AGENTS.md (briefing template)',
    true,
  );
  await writeFileUnlessPresent(
    path.join(targetDir, 'SETUP_INSTRUCTIONS.md'),
    setupInstructions,
    force,
    'SETUP_INSTRUCTIONS.md',
  );

  const excludedLocally = track ? false : await excludeLocally(targetDir, BRIEFING_FILES);

  if (track) {
    console.log(
      '\n- Mode: tracked (--track). Briefing files are intended to be committed to git in this repo.',
    );
  } else {
    console.log(
      excludedLocally
        ? `\n- Mode: excluded (default). ${BRIEFING_FILES.join(', ')} are excluded via .git/info/exclude (local only).\n  Teammates will not see them unless they bootstrap too. Pass --track if you want them committed.`
        : `\n- Mode: unknown (no git repo found). Briefing files were written to disk but not marked for tracking.`,
    );
  }

  if (noHook) {
    console.log('\n- --no-hook passed: pre-commit hook not installed.');
    console.log(`  To install it later, either drop --no-hook on a re-run, or add these lines`);
    console.log(`  to .git/hooks/pre-commit yourself:`);
    console.log(`    node ${shellSingleQuote(toPosixPath(guardScriptPath))} --staged`);
    console.log(`    node ${shellSingleQuote(toPosixPath(validateScriptPath))} --staged`);
  } else {
    console.log();
    await installPreCommitHook(targetDir, validateScriptPath, guardScriptPath);
  }

  console.log(`
Next:
  1. Open ${path.join(targetDir, 'SETUP_INSTRUCTIONS.md')} — the first agent that reads
     this repo fills in AGENTS.md from the real code, self-checks every path it
     claims, and asks you to confirm before treating it as source of truth.
  2. Once you confirm, delete SETUP_INSTRUCTIONS.md and commit AGENTS.md.
  3. From then on AGENTS.md changes through normal code review. Nothing ever
     regenerates it wholesale.

Done.`);
}

main().catch((err) => {
  console.error(`naso bootstrap: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
