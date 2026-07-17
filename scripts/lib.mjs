// Shared zero-dependency helpers for NASO automation scripts.
// Built entirely on Node.js core modules — no npm packages.

import { access, readFile, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Does a path exist on disk? */
export async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a JSON file. Returns null if missing or invalid. */
export async function readJSONFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Return the first candidate filename that exists directly under cwd. */
export async function firstExisting(cwd, candidates) {
  for (const name of candidates) {
    if (await pathExists(path.join(cwd, name))) return name;
  }
  return null;
}

/** Return every candidate filename that exists directly under cwd. */
export async function allExisting(cwd, candidates) {
  const found = [];
  for (const name of candidates) {
    if (await pathExists(path.join(cwd, name))) found.push(name);
  }
  return found;
}

/**
 * Run a command safely (array args, no shell interpolation).
 * By default captures stdout/stderr. Pass { inherit: true } to stream
 * output directly to the parent process instead (useful for lint/test/tsc).
 * Never throws — command failures and spawn errors both resolve normally.
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd ?? process.cwd(),
        stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }

    let stdout = '';
    let stderr = '';

    if (!opts.inherit) {
      child.stdout?.on('data', (chunk) => (stdout += chunk));
      child.stderr?.on('data', (chunk) => (stderr += chunk));
    }

    child.on('error', (err) => {
      resolve({ ok: false, code: -1, stdout, stderr: String(err?.message ?? err) });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

const KNOWN_PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'];

/** Detect the JS package manager from the packageManager field or lockfiles. */
export async function detectPackageManager(cwd, pkg) {
  if (pkg?.packageManager) {
    const name = String(pkg.packageManager).split('@')[0];
    if (KNOWN_PACKAGE_MANAGERS.includes(name)) return name;
  }
  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (
    (await pathExists(path.join(cwd, 'bun.lockb'))) ||
    (await pathExists(path.join(cwd, 'bun.lock')))
  ) {
    return 'bun';
  }
  if (await pathExists(path.join(cwd, 'package-lock.json'))) return 'npm';
  return pkg ? 'npm' : null;
}

/** Build [cmd, args] to run a package.json script via the detected package manager. */
export function pmRunCommand(pm, scriptName) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', ['run', scriptName]];
    case 'yarn':
      return ['yarn', ['run', scriptName]];
    case 'bun':
      return ['bun', ['run', scriptName]];
    case 'npm':
    default:
      return ['npm', ['run', scriptName]];
  }
}

/** Build [cmd, args] to execute a locally-installed binary via the detected package manager. */
export function pmExecCommand(pm, bin, args = []) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', ['exec', bin, ...args]];
    case 'yarn':
      return ['yarn', [bin, ...args]];
    case 'bun':
      return ['bunx', [bin, ...args]];
    case 'npm':
    default:
      return ['npx', ['--no-install', bin, ...args]];
  }
}

/** Does a locally-installed binary exist in node_modules/.bin? */
export async function hasLocalBin(cwd, bin) {
  const binName = process.platform === 'win32' ? `${bin}.cmd` : bin;
  return pathExists(path.join(cwd, 'node_modules', '.bin', binName));
}

/** Collect git branch, working-tree status, and ahead/behind vs upstream. Null if not a repo. */
export async function getGitInfo(cwd) {
  const isRepo = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!isRepo.ok) return null;

  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = branchRes.ok ? branchRes.stdout.trim() : 'unknown';

  const statusRes = await run('git', ['status', '--porcelain'], { cwd });
  const changes = statusRes.ok ? statusRes.stdout.split('\n').filter(Boolean) : [];

  const upstreamRes = await run(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd },
  );

  let upstream = null;
  let ahead = 0;
  let behind = 0;

  if (upstreamRes.ok) {
    upstream = upstreamRes.stdout.trim();
    const countRes = await run(
      'git',
      ['rev-list', '--left-right', '--count', `${upstream}...HEAD`],
      { cwd },
    );
    if (countRes.ok) {
      const [b, a] = countRes.stdout.trim().split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  }

  return { branch, changes, upstream, ahead, behind };
}

/** Parse `git status --porcelain` output into { status, path } entries, resolving renames. */
export function parseGitStatusPorcelain(raw) {
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || '??';
      const rawPath = line.slice(3).trim();
      const filePath = rawPath.includes(' -> ')
        ? (rawPath.split(' -> ').at(-1)?.trim() ?? rawPath)
        : rawPath;
      return { status, path: filePath };
    });
}

/** Paths currently staged for commit (added/copied/modified/renamed — not deleted). */
export async function getStagedFiles(cwd) {
  const res = await run(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd },
  );
  return res.ok ? res.stdout.split('\n').filter(Boolean) : [];
}

/** Minimal `--flag` / positional argv parser shared by every script's CLI. */
export function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg.slice(2));
    else positional.push(arg);
  }
  return { flags, positional };
}
