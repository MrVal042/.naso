// NASO Lock — a cooperative, filesystem-based mutex.
//
// Concurrent agents (or two shells, or a CI run racing a local commit) must not
// rewrite AGENTS.md at the same moment. The lock lives in the *target* repo,
// not in .naso, because the collision is between writers of one repo's
// AGENTS.md — a central lock would serialize unrelated repositories for no
// reason.
//
// Mechanism: exclusive file creation ('wx' / O_EXCL). That single call is
// atomic on POSIX and on Windows, so it needs no server, no daemon, and no
// dependency.
//
// Crash safety: a lock older than STALE_MS is assumed abandoned (its holder was
// killed mid-write and can never release it) and is broken. Staleness is the
// only recovery path, so the threshold is generous — long enough to cover a slow
// but healthy fill-in, short enough that a crash doesn't block the repo for
// hours.

import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actorIdentity } from './lib.mjs';

/** Abandon a lock older than 15 minutes. */
const STALE_MS = 15 * 60 * 1000;

export const LOCK_FILENAME = '.naso.lock';

export function lockPath(repoRoot) {
  return path.join(repoRoot, LOCK_FILENAME);
}

/**
 * One-line owner description for messages. The lock file is a small key/value
 * block, but only its `holder:` line belongs in a console message.
 */
function describeHolder(raw) {
  const holderLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('holder:'));
  const owner = holderLine ? holderLine.slice('holder:'.length).trim() : '';
  return owner.length > 0 ? owner : 'another process';
}

/** Read the lock file's owner string, or null if absent/unreadable. */
async function readHolder(lockFile) {
  try {
    return (await readFile(lockFile, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Is this lock old enough to break? Returns null when the lock is live. */
async function staleHolder(lockFile) {
  let stat;
  try {
    stat = await (await import('node:fs/promises')).stat(lockFile);
  } catch {
    return null; // vanished between calls; nothing to break
  }
  if (Date.now() - stat.mtimeMs <= STALE_MS) return null;
  return describeHolder(await readHolder(lockFile));
}

/**
 * Try to take the lock. Returns { acquired: true, release } on success, or
 * { acquired: false, holder } if someone else holds it.
 *
 * A released handle is idempotent, so callers that bail out early (or throw)
 * can still call it without special-casing.
 */
export async function acquire(repoRoot, { reason = 'update AGENTS.md' } = {}) {
  const lockFile = lockPath(repoRoot);
  await mkdir(path.dirname(lockFile), { recursive: true });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(lockFile, { force: true }).catch(() => {});
  };

  const buildPayload = (recoveredFrom) =>
    [
      `holder: ${actorIdentity()}`,
      `pid: ${process.pid}`,
      `reason: ${reason}`,
      `started: ${new Date().toISOString()}`,
      ...(recoveredFrom ? [`recovered-from: ${recoveredFrom}`] : []),
      '',
    ].join('\n');

  try {
    // 'wx' fails if the path already exists — the atomic test-and-set.
    const handle = await open(lockFile, 'wx');
    try {
      await handle.writeFile(buildPayload(), 'utf8');
    } finally {
      await handle.close();
    }
    return { acquired: true, release, lockFile };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  // Someone holds it. Break it only if it's genuinely stale.
  const stale = await staleHolder(lockFile);
  if (stale === null) {
    return {
      acquired: false,
      release,
      lockFile,
      holder: describeHolder(await readHolder(lockFile)),
    };
  }

  await rm(lockFile, { force: true }).catch(() => {});
  try {
    const handle = await open(lockFile, 'wx');
    try {
      await handle.writeFile(buildPayload(stale), 'utf8');
    } finally {
      await handle.close();
    }
    return { acquired: true, release, lockFile, recoveredFrom: stale };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    return {
      acquired: false,
      release,
      lockFile,
      holder: describeHolder(await readHolder(lockFile)),
    };
  }
}

/**
 * Run `fn` while holding the lock. On contention, reports and gives up rather
 * than queueing — a second agent should see the first one's work rather than
 * silently overwrite it minutes later.
 *
 * `onBusy` receives the holder name so callers can explain the skip.
 */
export async function withLock(repoRoot, fn, { reason, onBusy } = {}) {
  const lock = await acquire(repoRoot, { reason });
  if (!lock.acquired) {
    onBusy?.(lock.holder);
    return { ok: false, holder: lock.holder };
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    await lock.release();
  }
}
