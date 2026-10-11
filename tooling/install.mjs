// NASO install — the git plumbing that `setup` uses, kept out of the conversation.
//
// Nothing here prompts, prints a menu, or asks a question. That separation is
// the point: `setup.mjs` decides *whether* to install, this file decides *how*,
// and the how is the part that has to be right on a machine that is not this
// one — a Windows path with spaces, a linked worktree, a `core.hooksPath`, a
// repository with no commits yet.
//
// No exports are user-facing. This module is an implementation detail of setup.

import { mkdir, writeFile, readFile, appendFile, rm, stat, chmod, rename, realpath } from 'node:fs/promises';
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

/**
 * Where a foreign pre-commit hook goes when the user chooses to chain it.
 *
 * Moved, never rewritten: the bytes and the mode are exactly what they were, and NASO's
 * hook calls this file first. If something already sits at this name, chaining refuses
 * rather than overwrite it.
 */
export const CHAINED_HOOK_NAME = 'pre-commit.pre-naso';
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

# A hook that was here before NASO, moved aside when you chose to chain it, runs
# first and unchanged. Its failure stops the commit exactly as it did before.
PRE_NASO_HOOK="$(dirname "$0")/${CHAINED_HOOK_NAME}"
if [ -f "$PRE_NASO_HOOK" ]; then
  if [ -x "$PRE_NASO_HOOK" ]; then
    "$PRE_NASO_HOOK" "$@" || exit $?
  else
    sh "$PRE_NASO_HOOK" "$@" || exit $?
  fi
fi

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
 * Everything the plan needs to know about the pre-commit hook before deciding.
 *
 *   state        'none' | 'naso' | 'foreign' | 'not-repo'
 *   trackedDir   core.hooksPath points inside the worktree at a directory git tracks
 *                (husky's `.husky/`), so a hook written there is a change to the
 *                repository, not to this machine
 *
 * Read only. Nothing here writes.
 */
export async function describeHook(targetDir) {
  const hooksDir = await resolveHooksDir(targetDir);
  if (!hooksDir) {
    return { state: 'not-repo', hooksDir: null, path: null, trackedDir: false, hooksPath: null };
  }

  const hookPath = path.join(hooksDir, 'pre-commit');
  const body = await readFile(hookPath, 'utf8').catch(() => null);
  const state = body === null ? 'none' : body.includes(HOOK_MARKER) ? 'naso' : 'foreign';

  const configured = await run('git', ['config', '--get', 'core.hooksPath'], { cwd: targetDir });
  const hooksPath = configured.ok && configured.stdout.trim() ? configured.stdout.trim() : null;

  let trackedDir = false;
  if (hooksPath) {
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: targetDir });
    const root = top.ok ? top.stdout.trim() : null;
    // Real paths on both sides: git reports the resolved top level, and on macOS a temp
    // directory under /var is really /private/var, which made a tracked .husky/ look like
    // it lived outside the repository.
    const real = async (p) => realpath(p).catch(() => path.resolve(p));
    const rel = root ? path.relative(await real(root), await real(hooksDir)) : null;
    if (rel !== null && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const listed = await run('git', ['ls-files', '-z', '--', toPosixPath(rel)], { cwd: root });
      trackedDir = listed.ok && listed.stdout.length > 0;
    }
  }

  return { state, hooksDir, path: hookPath, trackedDir, hooksPath };
}

/**
 * Write the pre-commit hook. Never over a hook NASO did not write.
 *
 *   action 'install'  write it when the slot is empty or already NASO's
 *   action 'chain'    move a foreign hook to CHAINED_HOOK_NAME, byte for byte, and
 *                     write NASO's hook, which calls it first
 *
 * A foreign hook is never replaced: it may be running lint-staged, a secret scanner or
 * a signing step, and replacing it would silently disable all three. A hooks directory
 * git tracks is refused unless `allowTracked` says the user chose it, because a hook
 * written there is a file in the next commit.
 */
export async function installPreCommitHook(
  targetDir,
  { report = () => {}, action = 'install', allowTracked = false } = {},
) {
  const hook = await describeHook(targetDir);

  if (hook.state === 'not-repo') {
    report('- Skipped the pre-commit hook: not a git repository.', 'warn');
    report('  To install it later, copy this into .git/hooks/pre-commit:', 'info');
    report(`    ${HOOK_MANUAL_LINE}`, 'info');
    return { ok: false, reason: 'not-a-repo' };
  }

  if (hook.trackedDir && !allowTracked) {
    report(
      `- Skipped the pre-commit hook: core.hooksPath is ${hook.hooksPath}, which git tracks. ` +
        'A hook written there would be part of the next commit.',
      'warn',
    );
    report(`  To run the NASO checks, add this to ${hook.path} yourself:`, 'info');
    report(`    ${HOOK_MANUAL_LINE}`, 'info');
    return { ok: false, reason: 'tracked-hooks-path', hookPath: hook.path };
  }

  if (hook.state === 'foreign') {
    if (action !== 'chain') {
      report(`- Skipped the pre-commit hook: ${hook.path} exists and was not written by NASO.`, 'warn');
      report('  To run the NASO checks, add this to it yourself:', 'info');
      report(`    ${HOOK_MANUAL_LINE}`, 'info');
      return { ok: false, reason: 'foreign-hook', hookPath: hook.path };
    }
    const chained = path.join(hook.hooksDir, CHAINED_HOOK_NAME);
    if (await pathExists(chained)) {
      report(`- Skipped the pre-commit hook: ${chained} already exists, and NASO will not overwrite it.`, 'warn');
      return { ok: false, reason: 'chain-target-exists', hookPath: hook.path };
    }
    // A rename keeps the bytes and the mode; nothing of the old hook is rewritten.
    await rename(hook.path, chained);
    report(`- Moved the existing hook to ${chained}, unchanged. NASO's hook runs it first.`, 'pass');
  }

  await mkdir(hook.hooksDir, { recursive: true });
  // No BOM and LF endings: Git for Windows runs this through `sh`, and a BOM
  // would make the shebang unrecognisable while CRLF would break it outright.
  await writeFile(hook.path, buildHookScript(), 'utf8');
  // On POSIX this is what makes the hook executable. A filesystem that refuses it is
  // reported, because a hook git cannot execute is a gate that silently never runs.
  try {
    await chmod(hook.path, 0o755);
  } catch (err) {
    report(`  ! Could not mark ${hook.path} executable (${err?.code ?? err}); git may skip it.`, 'warn');
  }

  report(`- Installed the pre-commit hook: ${hook.path}`, 'pass');
  report(`  It runs ${NASO_DIR}/tooling/validate.mjs from this repository.`, 'info');
  return { ok: true, hookPath: hook.path, chained: hook.state === 'foreign' };
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
 * The patterns .git/info/exclude can actually keep out of git here.
 *
 * An exclude line only hides untracked files. A repository that already commits its own
 * AGENTS.md keeps tracking it whatever the exclude file says, so writing the line anyway
 * and reporting the file as "kept out of git" was a claim git does not honour: the
 * appended NASO block showed up in `git status`, one `git commit -a` from the history.
 */
export async function localExcludePatterns(targetDir) {
  const kept = [];
  for (const pattern of LOCAL_EXCLUDE_PATTERNS) {
    const tracked = await run('git', ['ls-files', '-z', '--', pattern], { cwd: targetDir });
    if (!(tracked.ok && tracked.stdout.length > 0)) kept.push(pattern);
  }
  return kept;
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
export async function excludeLocally(targetDir, patterns = null) {
  const pending = await pendingLocalExclusion(targetDir, patterns);
  if (!pending) return false;
  if (pending.missing.length === 0) return true;

  await mkdir(path.dirname(pending.path), { recursive: true });
  await appendFile(pending.path, pending.text, 'utf8');
  return true;
}

/**
 * What `excludeLocally` would append to .git/info/exclude, without appending it.
 *
 * Returns null outside a git repository. `missing` is the patterns not already there and
 * `text` the exact bytes that would be appended, so a plan can show the change first.
 */
export async function pendingLocalExclusion(targetDir, patterns = null) {
  const gitDirRes = await run('git', ['rev-parse', '--git-dir'], { cwd: targetDir });
  if (!gitDirRes.ok) return null;
  patterns ??= await localExcludePatterns(targetDir);

  const gitDirRaw = gitDirRes.stdout.trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(targetDir, gitDirRaw);
  const excludePath = path.join(gitDir, 'info', 'exclude');
  const existing = await readFile(excludePath, 'utf8').catch(() => '');

  const missing = patterns.filter((pattern) => !existing.includes(pattern));
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const text = missing.length === 0 ? '' : `${prefix}\n${EXCLUDE_MARKER}\n${missing.join('\n')}\n`;
  return { path: excludePath, missing, text };
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

  // AGENTS.md is not a leftover. It is the briefing — the owner's file, or the one NASO
  // just wrote — and the plan already says what happens to it. Listing it here put a
  // repository's own documentation under "Leftovers to remove" and made doctor warn on
  // every healthy install.
  for (const file of OWNED_FILES.filter((name) => name !== 'AGENTS.md')) {
    const full = path.join(targetDir, file);
    if (await pathExists(full)) {
      found.push({
        path: full,
        label: file,
        owned: 'yes',
        note: 'NASO 2.x one-time setup guide, obsolete in 3.0',
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
  const failed = [];

  for (const artifact of artifacts) {
    if (onlyOwned && artifact.owned !== 'yes') {
      kept.push(artifact);
      continue;
    }
    // A delete that failed is reported as failed. Listing it as removed told the user a
    // stale lock was gone while it went on blocking every write to AGENTS.md.
    try {
      await rm(artifact.path, { force: true });
      removed.push(artifact);
    } catch (err) {
      failed.push({ ...artifact, error: err?.code ?? String(err) });
    }
  }

  return { removed, kept, failed };
}

/** Absolute path to a tool script, for display and for hook bodies. */
export function toolScriptPath(name) {
  return path.join(nasoDir(), 'tooling', name);
}
