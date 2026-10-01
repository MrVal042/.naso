#!/usr/bin/env node
// NASO Guard — warn-only, stack-agnostic checks for the mistakes that actually
// cost you time: leaked secrets, committed build output, unreviewed dependency
// changes.
//
// Generic by design: it matches path shapes, never project-specific names, and
// reads paths only — never file contents. Nothing it does depends on the
// repository's language, framework, or directory layout.
//
// Usage: node .naso/scripts/guard.mjs [target-dir] [--staged] [--strict]
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import { pathExists, parseGitStatusPorcelain, getStagedFiles, parseArgs, run } from './lib.mjs';

// Matches paths that conventionally hold secrets. Deliberately broad: a false
// positive costs one glance at a filename, a false negative costs a leak.
const SECRET_LIKE_PATTERN =
  /(^|\/)(\.env($|[./-])|.*\.pem$|.*\.p12$|.*\.pfx$|.*\.key$|.*secret.*|.*credential.*|.*token.*|.*key.*|id_rsa.*|id_ed25519.*)/i;

// Directories that hold build output or dependencies in the common stacks.
const GENERATED_DIR_PATTERN =
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.output|\.turbo|\.svelte-kit|\.angular|vendor|__pycache__|target)(\/|$)/i;

// node_modules and friends, however the stack spells them.
const DEPENDENCY_DIR_PATTERN =
  /(^|\/)(node_modules|vendor|bower_components|\.venv|venv|\.tox|\.gradle)(\/|$)/i;

const SOURCE_MAP_PATTERN = /\.map$/i;

const DEPENDENCY_FILE_PATTERN =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|Pipfile|Pipfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle|build\.gradle\.kts|Podfile|Podfile\.lock)$/i;

const GUIDANCE = [
  {
    title: 'Secret-like paths changed',
    next: 'Review paths only — do not paste contents into chat. Real secrets belong in a deployment secret store.',
    match: (p) => SECRET_LIKE_PATTERN.test(p),
  },
  {
    title: 'Generated, build-output, or dependency paths changed',
    next: 'Do not commit generated output or installed dependencies unless this repo explicitly tracks them.',
    match: (p) =>
      GENERATED_DIR_PATTERN.test(p) || DEPENDENCY_DIR_PATTERN.test(p) || SOURCE_MAP_PATTERN.test(p),
  },
  {
    title: 'Dependency manifest or lockfile changed',
    next: 'Confirm dependency changes are intentional before committing.',
    match: (p) => DEPENDENCY_FILE_PATTERN.test(p),
  },
];

function collectWarnings(paths) {
  const warnings = [];
  for (const guidance of GUIDANCE) {
    const files = Array.from(new Set(paths.filter(guidance.match))).sort();
    if (files.length > 0) warnings.push({ title: guidance.title, files, next: guidance.next });
  }
  return warnings;
}

async function getChangedPaths(cwd, staged) {
  if (staged) return getStagedFiles(cwd);
  const res = await run('git', ['status', '--porcelain'], { cwd });
  if (!res.ok) return null;
  return parseGitStatusPorcelain(res.stdout).map((entry) => entry.path);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const staged = flags.has('staged');
  const strict = flags.has('strict');
  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso guard: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const paths = await getChangedPaths(cwd, staged);
  if (paths === null) {
    console.error('naso guard: unable to read git status (not a git repository?).');
    process.exitCode = staged ? 1 : 0;
    return;
  }

  const warnings = collectWarnings(paths);

  console.log(`# NASO Guard (${staged ? 'staged' : 'working tree'}) — ${cwd}`);
  console.log('');
  console.log(`Changed paths checked: ${paths.length}`);
  console.log(`Mode: ${strict ? 'strict (fails on warnings)' : 'warn-only'}`);
  console.log('');

  if (warnings.length === 0) {
    console.log('No guard warnings.');
    process.exitCode = 0;
    return;
  }

  for (const warning of warnings) {
    console.log(`## ${warning.title}`);
    for (const filePath of warning.files) console.log(`- ${filePath}`);
    console.log(`Next: ${warning.next}`);
    console.log('');
  }

  process.exitCode = strict ? 1 : 0;
}

main().catch((err) => {
  console.error(`naso guard: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
