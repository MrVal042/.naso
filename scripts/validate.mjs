#!/usr/bin/env node
// NASO Validate — the standard-operating-procedure gatekeeper.
// Runs lint, typecheck, tests, and format checks (whichever apply to the
// target project) and exits non-zero if any configured check fails.
//
// Usage: node .naso/scripts/validate.mjs [target-dir]
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import {
  pathExists,
  readJSONFile,
  allExisting,
  detectPackageManager,
  pmRunCommand,
  pmExecCommand,
  hasLocalBin,
  run,
} from './lib.mjs';

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

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[status];
  console.log(`\n[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runStep(name, cmd, args, cwd) {
  console.log(`\n--- ${name}: running \`${cmd} ${args.join(' ')}\` ---`);
  const result = await run(cmd, args, { cwd, inherit: true });
  if (result.ok) {
    record(name, 'pass');
  } else {
    record(name, 'fail', `exit code ${result.code}`);
  }
  return result.ok;
}

async function main() {
  const targetArg = process.argv[2];
  const cwd = path.resolve(targetArg ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso validate: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# NASO Validate — ${cwd}`);

  const pkgPath = path.join(cwd, 'package.json');
  const pkg = await readJSONFile(pkgPath);

  if (!pkg) {
    console.log('\nNo package.json found — nothing to validate for a JS/TS project.');
    console.log('\n## Summary\n\nNo applicable checks were found. Nothing failed.');
    process.exitCode = 0;
    return;
  }

  const pm = await detectPackageManager(cwd, pkg);
  const scripts = pkg.scripts ?? {};

  // 1. Lint
  if (scripts.lint) {
    const [cmd, args] = pmRunCommand(pm, 'lint');
    await runStep('Lint', cmd, args, cwd);
  } else {
    record('Lint', 'skip', 'no "lint" script in package.json');
  }

  // 2. TypeScript compilation
  const hasTsconfig = await pathExists(path.join(cwd, 'tsconfig.json'));
  if (hasTsconfig) {
    if (await hasLocalBin(cwd, 'tsc')) {
      const [cmd, args] = pmExecCommand(pm, 'tsc', ['--noEmit']);
      await runStep('TypeScript', cmd, args, cwd);
    } else {
      record('TypeScript', 'skip', 'tsconfig.json present but tsc is not installed locally');
    }
  } else {
    record('TypeScript', 'skip', 'no tsconfig.json');
  }

  // 3. Tests
  if (scripts.test) {
    const [cmd, args] = pmRunCommand(pm, 'test');
    await runStep('Tests', cmd, args, cwd);
  } else {
    record('Tests', 'skip', 'no "test" script in package.json');
  }

  // 4. Format check
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

  // Summary
  console.log('\n## Summary\n');
  for (const r of results) {
    const icon = { pass: '✓', fail: '✗', skip: '—' }[r.status];
    console.log(`${icon} ${r.name}: ${r.status.toUpperCase()}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll applicable checks passed.');
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error(`naso validate: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
