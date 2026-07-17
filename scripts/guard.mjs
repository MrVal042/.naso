#!/usr/bin/env node
// NASO Guard — warn-only, stack-agnostic checks for the mistakes that
// actually cost a contractor: leaked secrets, committed build output,
// unreviewed dependency changes. Generalized from Patonabl's
// tooling/scripts/codebase-guard.mjs, which validated this pattern in
// production.
//
// Never reads flagged file contents — path only.
//
// Usage: node .naso/scripts/guard.mjs [target-dir] [--staged] [--strict]
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import { pathExists, parseGitStatusPorcelain, getStagedFiles, parseArgs, run } from './lib.mjs';

const SECRET_LIKE_PATTERN =
  /(^|\/)(\.env($|[./_-])|.*\.secret($|[./_-])|.*secret.*|.*credential.*|.*token.*|.*key.*)/i;

const GENERATED_OUTPUT_PATTERN =
  /(^|\/)(dist|build|coverage|out|target|\.next|\.nuxt|\.output|\.turbo|node_modules)(\/|$)|\.map$/;

const DEPENDENCY_FILE_PATTERN =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|Gemfile\.lock|requirements\.txt|go\.sum|Cargo\.lock|composer\.lock)$/;

function addWarning(warnings, title, files, nextAction) {
  if (files.length === 0) return;
  warnings.push({ title, files: Array.from(new Set(files)).sort(), nextAction });
}

async function getChangedPaths(cwd, staged) {
  if (staged) {
    return getStagedFiles(cwd);
  }
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

  const warnings = [];

  addWarning(
    warnings,
    'Secret-like paths changed',
    paths.filter((p) => SECRET_LIKE_PATTERN.test(p)),
    'Review paths only — do not paste contents into chat. Move real secrets to a deployment secret store.',
  );

  addWarning(
    warnings,
    'Generated or build-output paths changed',
    paths.filter((p) => GENERATED_OUTPUT_PATTERN.test(p)),
    'Do not commit generated output unless the repo explicitly tracks it.',
  );

  addWarning(
    warnings,
    'Dependency or lockfile changes',
    paths.filter((p) => DEPENDENCY_FILE_PATTERN.test(p)),
    'Confirm dependency changes are intentional before committing.',
  );

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
    for (const filePath of warning.files) {
      console.log(`- ${filePath}`);
    }
    console.log(`Next: ${warning.nextAction}`);
    console.log('');
  }

  process.exitCode = strict ? 1 : 0;
}

main().catch((err) => {
  console.error(`naso guard: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
