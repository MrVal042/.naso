// NASO vendor — the copy of the tooling that lives inside a target repository.
//
// The copy is what makes the pre-commit hook portable. A hook that hardcoded a path
// into somebody's npm cache would work until that cache was cleared, then refuse every
// commit in the repository with an error nobody could act on. A copy of a dozen small
// scripts is cheap and always there.
//
// What is copied, and why exactly this:
//
//   tooling/*.mjs   the code the hook and the other commands run
//   tooling/README.md  the maintenance guide, so the copy documents itself
//   VERSION         the version this copy came from — the briefing stamp is
//                   compared against it, not against the ambient install
//
// What is NOT copied, deliberately: the package manifest and the bin entry point. Those
// belong to the package, not to the repository, and a repository that grew its own copy
// of them would end up with two versions of `naso-dev` in one tree.

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists, readJSONFile, run, nasoDir } from './lib.mjs';

/** Directory, relative to a repository root, that holds everything NASO writes. */
export const NASO_DIR = '.naso';

/** Where the tool scripts land inside a target repository. */
export function vendoredToolingDir(repoRoot) {
  return path.join(repoRoot, NASO_DIR, 'tooling');
}

/** One vendored script, by file name (`validate.mjs`). */
export function vendoredScriptPath(repoRoot, name) {
  return path.join(vendoredToolingDir(repoRoot), name);
}

/** `.naso/config.json` for a repository, or null when it does not exist. */
export function configPath(repoRoot) {
  return path.join(repoRoot, NASO_DIR, 'config.json');
}

/**
 * Per-repository settings: what mode setup ran in, and which areas the user asked to
 * keep out of the briefing.
 *
 * `refresh` never writes this file. It records a decision a human made about a specific
 * repository, and a version bump is not a reason to revisit it.
 */
export async function readConfig(repoRoot) {
  return (await readJSONFile(configPath(repoRoot))) ?? {};
}

/**
 * One normalization for exclusions, whether they arrive from a config file or a flag.
 *
 * `vendor/`, `./vendor` and `vendor///` have to mean the same directory, or a briefing
 * silently describes a folder the user just asked it to ignore.
 */
export function normalizeExclusions(prefixes) {
  const raw = Array.isArray(prefixes) ? prefixes : [];
  return [
    ...new Set(
      raw
        .map((prefix) => String(prefix).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ].sort();
}

/** Areas the user excluded, normalized and sorted. Always an array. */
export function configuredExclusions(config) {
  return normalizeExclusions(Array.isArray(config?.exclude) ? config.exclude : []);
}

/** Is this repository path under one of the excluded prefixes? */
export function isExcluded(relPath, prefixes) {
  const normalized = String(relPath).replace(/\\/g, '/');
  return prefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/**
 * Every file that gets vendored, as absolute source paths.
 *
 * Discovered rather than hardcoded, so a new module is picked up by `refresh` without
 * anybody remembering to edit this list — the failure mode of a hand-maintained manifest
 * is a hook that breaks only for the one command someone forgot.
 */
export async function vendorSources() {
  const dir = path.join(nasoDir(), 'tooling');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();
  if ((await pathExists(path.join(dir, 'README.md')))) names.push('README.md');
  return names.map((name) => path.join(dir, name));
}

/** Has this repository already been set up? */
export async function isVendored(repoRoot) {
  return pathExists(vendoredScriptPath(repoRoot, 'validate.mjs'));
}

/**
 * Copy the tooling into `<repo>/.naso/tooling/` and stamp the copy with this version.
 *
 * Returns the list of vendored file names. Existing files are overwritten without
 * ceremony: they are ours, they live in a directory only NASO writes, and an out-of-date
 * copy is exactly the thing `refresh` exists to fix.
 */
export async function vendorTooling(repoRoot, { version } = {}) {
  const sources = await vendorSources();
  const targetDir = vendoredToolingDir(repoRoot);
  await mkdir(targetDir, { recursive: true });

  for (const source of sources) {
    await copyFile(source, path.join(targetDir, path.basename(source)));
  }

  const stamped = version ?? (await readFile(path.join(nasoDir(), 'VERSION'), 'utf8')).trim();
  await writeFile(path.join(targetDir, 'VERSION'), `${stamped}\n`, 'utf8');

  return [...sources.map((s) => path.basename(s)), 'VERSION'];
}

/** Version of the vendored copy, or null when there is no copy to read. */
export async function vendoredVersion(repoRoot) {
  const raw = await readFile(path.join(vendoredToolingDir(repoRoot), 'VERSION'), 'utf8').catch(
    () => null,
  );
  return raw === null ? null : raw.trim();
}

/**
 * Write `.naso/config.json`.
 *
 * Separate from `vendorTooling` on purpose: `refresh` calls the first and must not call
 * the second.
 */
export async function writeConfig(repoRoot, { version, actor, now, track, hook, exclude = [] }) {
  const file = configPath(repoRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        version,
        generatedBy: actor,
        generatedAt: now,
        tooling: `${NASO_DIR}/tooling`,
        hook,
        track,
        exclude: configuredExclusions({ exclude }),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return file;
}

/** Root of the repository as git itself defines it, for path resolution from a subdir. */
export async function repoRoot(cwd) {
  const res = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (!res.ok) return null;
  const raw = res.stdout.trim();
  return raw ? path.resolve(cwd, raw) : null;
}
