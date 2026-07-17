#!/usr/bin/env node
// NASO Validate — the standard-operating-procedure gatekeeper.
//
// Two modes:
//   --staged (the git pre-commit hook): Prettier + ESLint on staged files
//     only, plus a branch-naming check. Targets < 2s so it never tempts a
//     `--no-verify` bypass.
//   default (CI / manual "done" gate): whole-project lint, `tsc --noEmit`,
//     tests, and format check.
//
// Usage: node .naso/scripts/validate.mjs [target-dir] [--staged]
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
  getStagedFiles,
  parseArgs,
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

// Bare trunk names, or a `prefix/slug` shape (feature/x, bugfix/x, hotfix/x, ...).
const BRANCH_NAME_PATTERN = /^(main|master|develop|dev|trunk)$|^[a-z0-9][a-z0-9._-]*\/.+$/i;

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

function printSummary() {
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
    record('Branch naming', 'pass', `\`${branch}\``);
  } else {
    record(
      'Branch naming',
      'fail',
      `\`${branch}\` does not match trunk names or a "prefix/slug" convention (e.g. feature/x, bugfix/x)`,
    );
  }
}

async function runStaged(cwd, pkg, pm) {
  const stagedFiles = await getStagedFiles(cwd);

  await checkBranchName(cwd);

  const prettierConfigFiles = await allExisting(cwd, PRETTIER_CONFIG_CANDIDATES);
  const hasPrettierConfig = prettierConfigFiles.length > 0 || Boolean(pkg?.prettier);

  if (stagedFiles.length === 0) {
    record('Format', 'skip', 'no staged files');
    record('Lint', 'skip', 'no staged files');
  } else {
    if (hasPrettierConfig) {
      if (await hasLocalBin(cwd, 'prettier')) {
        const [cmd, args] = pmExecCommand(pm, 'prettier', [
          '--check',
          '--ignore-unknown',
          ...stagedFiles,
        ]);
        await runStep('Format', cmd, args, cwd);
      } else {
        record('Format', 'skip', 'prettier config present but prettier is not installed locally');
      }
    } else {
      record('Format', 'skip', 'no prettier configuration found');
    }

    const lintableFiles = stagedFiles.filter((f) =>
      /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/.test(f),
    );
    if (pkg?.scripts?.lint && (await hasLocalBin(cwd, 'eslint'))) {
      if (lintableFiles.length === 0) {
        record('Lint', 'skip', 'no staged files with a lintable extension');
      } else {
        const [cmd, args] = pmExecCommand(pm, 'eslint', lintableFiles);
        await runStep('Lint', cmd, args, cwd);
      }
    } else {
      record('Lint', 'skip', 'no "lint" script or eslint is not installed locally');
    }
  }

  printSummary();
}

async function runFull(cwd, pkg, pm) {
  const scripts = pkg.scripts ?? {};

  // 1. Lint
  if (scripts.lint) {
    const [cmd, args] = pmRunCommand(pm, 'lint');
    await runStep('Lint', cmd, args, cwd);
  } else {
    record('Lint', 'skip', 'no "lint" script in package.json');
  }

  // 2. TypeScript compilation
  // Prefer the project's own "typecheck" script — it may wrap tsc with
  // required pre-steps (codegen, prisma generate, etc.). Only fall back to
  // a bare `tsc --noEmit` when the project hasn't defined one.
  const hasTsconfig = await pathExists(path.join(cwd, 'tsconfig.json'));
  if (scripts.typecheck) {
    const [cmd, args] = pmRunCommand(pm, 'typecheck');
    await runStep('TypeScript', cmd, args, cwd);
  } else if (hasTsconfig) {
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

  printSummary();
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const staged = flags.has('staged');
  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso validate: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# NASO Validate (${staged ? 'staged' : 'full'}) — ${cwd}`);

  const pkg = await readJSONFile(path.join(cwd, 'package.json'));

  if (!pkg) {
    if (staged) {
      await checkBranchName(cwd);
      record('Format', 'skip', 'no package.json — nothing to validate for a JS/TS project');
      record('Lint', 'skip', 'no package.json — nothing to validate for a JS/TS project');
      printSummary();
      return;
    }
    console.log('\nNo package.json found — nothing to validate for a JS/TS project.');
    console.log('\n## Summary\n\nNo applicable checks were found. Nothing failed.');
    process.exitCode = 0;
    return;
  }

  const pm = await detectPackageManager(cwd, pkg);

  if (staged) {
    await runStaged(cwd, pkg, pm);
  } else {
    await runFull(cwd, pkg, pm);
  }
}

main().catch((err) => {
  console.error(`naso validate: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
