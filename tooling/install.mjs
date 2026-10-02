// NASO install — the git plumbing that `setup` uses, kept out of the conversation.
//
// Nothing here prompts, prints a menu, or asks a question. That separation is
// the point: `setup.mjs` decides *whether* to install, this file decides *how*,
// and the how is the part that has to be right on a machine that is not this
// one — a Windows path with spaces, a linked worktree, a `core.hooksPath`, a
// repository with no commits yet.
//
// No exports are user-facing. This module is an implementation detail of setup.

import { mkdir, writeFile, readFile, appendFile, rm, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  run,
  shellSingleQuote,
  toPosixPath,
  nasoDir,
} from './lib.mjs';
import { NASO_DIR, vendoredToolingDir, vendoredScriptPath } from './vendor.mjs';

const HOOK_MARKER = '# managed-by: naso-dev';
const EXCLUDE_MARKER = '# added by naso-dev setup';

/**
 * Files NASO may have written into a target repository.
 *
 * `SETUP_INSTRUCTIONS.md` is here because it shipped in NASO 2.x and a 3.0 setup
 * that finds one should remove it — leaving it behind sends the next agent back
 * through a fill-in flow that no longer exists.
 */
export const OWNED_FILES = ['AGENTS.md', 'SETUP_INSTRUCTIONS.md'];

/**
 * Everything NASO writes into a repository, and everything `.git/info/exclude` should
 * keep out of git in local mode.
 *
 * `.naso/` is here because it is NASO's, not the project's: a vendored copy of a
 * development tool has no business in a client's history, and a teammate gets their own
 * from `setup` in three seconds.
 */
export const LOCAL_EXCLUDE_PATTERNS = [NASO_DIR, 'AGENTS.md'];

/** The tool scripts the hook calls, by their file name. */
export function toolPaths() {
  const dir = path.join(nasoDir(), 'tooling');
  return {
    validate: path.join(dir, 'validate.mjs'),
    briefing: path.join(dir, 'briefing.mjs'),
  };
}

/** What a human should type to run the gate by hand, without a hook. */
export const HOOK_MANUAL_LINE = `node ${NASO_DIR}/tooling/validate.mjs --staged`;

/**
 * The pre-commit hook body.
 *
 * One command, not two. In 2.x the hook ran guard then validate, which meant a
 * slow lint ran after the secret check and could mask it; now the secret rules
 * are the first thing validate does, so a blocked secret is reported in
 * milliseconds and never behind a test run.
 *
 * The script it runs is the copy inside this repository, resolved from
 * `git rev-parse --show-toplevel` rather than from whatever the package happened to be
 * installed as. Three consequences, all of them the point:
 *
 *   - it works in the npx cache, in a global install, or on a machine that never
 *     installed the package at all;
 *   - it survives the package being deleted, upgraded or cache-evicted;
 *   - it is identical for every clone, so a teammate gets the same gate.
 *
 * When the copy is missing, the hook says so in one loud line and exits 0. Blocking every
 * commit in a repository over a missing helper — with a stack trace, from inside a hook
 * nobody thinks to read — is a worse failure than a skipped check with a visible warning.
 *
 * Cross-platform notes, since this is the one piece that genuinely differs.
 * Git for Windows executes hooks through its bundled POSIX `sh`, so `#!/bin/sh`
 * is correct on both platforms and needs no `.cmd` variant. What does differ is
 * path handling — Windows paths carry spaces and `C:\` prefixes, so every
 * interpolated path is converted to forward slashes and single-quoted before it
 * reaches the shell body.
 */
export function buildHookScript() {
  // No shellSingleQuote here. The value lands inside a double-quoted assignment, so
  // single quotes would be taken as part of the *path* and `[ -f "$NASO_SCRIPT" ]` would
  // never match — the hook would report itself missing on every commit.
  const script = toPosixPath(`${NASO_DIR}/tooling/validate.mjs`);
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by NASO. Runs the secret, scope, format and lint checks on staged files
# before each commit, and keeps AGENTS.md current.
#
# The gate itself is the copy in this repository, so it keeps working with no
# network, no global install and no package cache. Edit or delete this file
# freely; it is not reinstalled behind your back.

# Resolve node: hooks inherit a minimal PATH on some systems, so fall back to
# the common install locations rather than failing with "command not found".
if command -v node >/dev/null 2>&1; then
  NODE_BIN=node
elif [ -x "/c/Program Files/nodejs/node.exe" ]; then
  NODE_BIN="/c/Program Files/nodejs/node.exe"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
else
  echo "naso-dev: node not found in PATH - pre-commit checks skipped." >&2
  exit 0
fi

# --show-toplevel, not $(pwd): git runs hooks from the top of the worktree, but a
# subdirectory or a linked worktree makes guessing the wrong answer easy.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || REPO_ROOT=$(pwd)
NASO_SCRIPT="$REPO_ROOT/${script}"

if [ ! -f "$NASO_SCRIPT" ]; then
  echo "naso-dev: $NASO_SCRIPT is missing - pre-commit checks skipped. Run: npx naso-dev refresh" >&2
  exit 0
fi

# --staged keeps this under a second on a normal commit: secrets, scope, format
# and lint on the staged files only, plus the one-line briefing append.
"$NODE_BIN" "$NASO_SCRIPT" --staged
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
export async function resolveHooksDir(targetDir) {
  const res = await run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: targetDir });
  if (!res.ok) return null;
  const raw = res.stdout.trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(targetDir, raw);
}

/**
 * Write the pre-commit hook, unless something that is not ours is already there.
 *
 * Refusing to overwrite a foreign hook is the only safe default: it may be
 * running a lint-staged config, a secret scanner, or a signing step, and
 * replacing it with ours would silently disable all three.
 */
export async function installPreCommitHook(targetDir, { report = () => {} } = {}) {
  const hooksDir = await resolveHooksDir(targetDir);

  if (!hooksDir) {
    report('- Skipped the pre-commit hook: not a git repository.', 'warn');
    report('  To install it later, copy this into .git/hooks/pre-commit:', 'info');
    report(`    ${HOOK_MANUAL_LINE}`, 'info');
    return { ok: false, reason: 'not-a-repo' };
  }

  const hookPath = path.join(hooksDir, 'pre-commit');

  if (await pathExists(hookPath)) {
    const existing = await readFile(hookPath, 'utf8').catch(() => '');
    if (!existing.includes(HOOK_MARKER)) {
      report(`- Skipped the pre-commit hook: ${hookPath} exists and was not written by NASO.`, 'warn');
      report('  To run the NASO checks, add this to it yourself:', 'info');
      report(`    ${HOOK_MANUAL_LINE}`, 'info');
      return { ok: false, reason: 'foreign-hook' };
    }
  }

  await mkdir(hooksDir, { recursive: true });
  // No BOM and LF endings: Git for Windows runs this through `sh`, and a BOM
  // would make the shebang unrecognisable while CRLF would break it outright.
  await writeFile(hookPath, buildHookScript(), 'utf8');
  // A no-op on Windows filesystems, harmless there; on POSIX this is what makes
  // the hook executable.
  await chmod(hookPath, 0o755).catch(() => {});

  report(`- Installed the pre-commit hook: ${hookPath}`, 'pass');
  report(`  It runs ${NASO_DIR}/tooling/validate.mjs from this repository.`, 'info');
  return { ok: true, hookPath };
}

/** Read the current hook body, or null when there is none. */
export async function readHook(targetDir) {
  const hooksDir = await resolveHooksDir(targetDir);
  if (!hooksDir) return null;
  const hookPath = path.join(hooksDir, 'pre-commit');
  const body = await readFile(hookPath, 'utf8').catch(() => null);
  return body === null ? null : { path: hookPath, body };
}

/** Is this hook the one NASO wrote? */
export function isNasoHook(hook) {
  return Boolean(hook?.body.includes(HOOK_MARKER));
}

/**
 * Keep the briefing files out of git entirely, using .git/info/exclude.
 *
 * That file is local-only and never committed, which is what makes it the right
 * mechanism: bootstrapping a client or contract repository leaves no trace in
 * its history, and no teammate receives a briefing generated for someone else's
 * machine. Repos that want the briefing reviewed like any other file pass --track
 * and skip this entirely.
 */
export async function excludeLocally(targetDir, patterns = LOCAL_EXCLUDE_PATTERNS) {
  const gitDirRes = await run('git', ['rev-parse', '--git-dir'], { cwd: targetDir });
  if (!gitDirRes.ok) return false;

  const gitDirRaw = gitDirRes.stdout.trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(targetDir, gitDirRaw);
  const excludePath = path.join(gitDir, 'info', 'exclude');
  const existing = await readFile(excludePath, 'utf8').catch(() => '');

  const missing = patterns.filter((pattern) => !existing.includes(pattern));
  if (missing.length === 0) return true;

  await mkdir(path.dirname(excludePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(
    excludePath,
    `${prefix}\n${EXCLUDE_MARKER}\n${missing.join('\n')}\n`,
    'utf8',
  );
  return true;
}

/** Remove NASO's block from .git/info/exclude. Undoes excludeLocally. */
export async function removeLocalExclusions(targetDir, patterns = LOCAL_EXCLUDE_PATTERNS) {
  const gitDirRes = await run('git', ['rev-parse', '--git-dir'], { cwd: targetDir });
  if (!gitDirRes.ok) return false;

  const gitDirRaw = gitDirRes.stdout.trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(targetDir, gitDirRaw);
  const excludePath = path.join(gitDir, 'info', 'exclude');
  const existing = await readFile(excludePath, 'utf8').catch(() => null);
  if (existing === null) return false;

  const lines = existing.split('\n');
  const kept = lines.filter(
    (line) => line.trim() !== EXCLUDE_MARKER && !patterns.includes(line.trim()),
  );
  await writeFile(excludePath, kept.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return true;
}

/** Is the file ignored by git? Respects .gitignore, excludes and global config. */
export async function isIgnored(targetDir, file) {
  const res = await run('git', ['check-ignore', '-q', file], { cwd: targetDir });
  return res.code === 0;
}

/**
 * Everything a failed or abandoned setup could have left behind, and whether it
 * is still there.
 *
 * Step 1 of the documented flow writes nothing at all, so this list is short by
 * design — it covers artefacts from older NASO versions and from a setup that
 * wrote the briefing and then failed before finishing. Reporting them by name
 * rather than deleting blind matters: the caller decides, and `--yes` on a
 * repository that legitimately has its own AGENTS.md must not eat it.
 */
export async function findArtifacts(targetDir) {
  const found = [];

  for (const file of OWNED_FILES) {
    const full = path.join(targetDir, file);
    if (await pathExists(full)) {
      found.push({
        path: full,
        label: file,
        owned: file === 'AGENTS.md' ? 'may' : 'yes',
        note:
          file === 'AGENTS.md'
            ? 'pre-existing or generated briefing — removed only when you ask'
            : 'NASO 2.x one-time setup guide, obsolete in 3.0',
      });
    }
  }

  const lock = path.join(targetDir, '.naso.lock');
  if (await pathExists(lock)) {
    let ageMinutes = null;
    try {
      ageMinutes = Math.round((Date.now() - (await stat(lock)).mtimeMs) / 60000);
    } catch {
      ageMinutes = null;
    }
    found.push({
      path: lock,
      label: '.naso.lock',
      owned: 'yes',
      note:
        ageMinutes !== null && ageMinutes < 15
          ? `held by another process, ${ageMinutes} min old — leave it alone`
          : 'stale lock from a crashed run — safe to remove',
      stale: ageMinutes === null || ageMinutes >= 15,
    });
  }

  return found;
}

/**
 * Delete the artefacts named in `findArtifacts`, and only those.
 *
 * Refuses anything the caller did not explicitly opt into. A tool that silently
 * deletes files in somebody's repository on the way out is a tool people stop
 * running, so every removal here is either a pattern we wrote ourselves
 * (`.naso.lock`, the 2.x setup guide) or an explicit instruction.
 */
export async function removeArtifacts(artifacts, { onlyOwned = true } = {}) {
  const removed = [];
  const kept = [];

  for (const artifact of artifacts) {
    if (onlyOwned && artifact.owned !== 'yes') {
      kept.push(artifact);
      continue;
    }
    await rm(artifact.path, { force: true }).catch(() => {});
    removed.push(artifact);
  }

  return { removed, kept };
}

/** Absolute path to a tool script, for display and for hook bodies. */
export function toolScriptPath(name) {
  return path.join(nasoDir(), 'tooling', name);
}
