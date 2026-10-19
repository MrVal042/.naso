#!/usr/bin/env node
// NASO Doctor — check Node, git, the hook, the briefing, and the install.
//
// The patient is the repository. The remedy is the next one command. No changes.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  pathExists,
  parseArgs,
  run,
  toolVersion,
  nasoDir,
  compareVersions,
  isMainModule,
  SUPPORT_EMAIL,
  nasoCommand,
  recordedNasoVersion,
  pinAdvice,
  detectPackageManager,
} from './lib.mjs';
import {
  scanRepo,
  checkBriefing,
  readBriefingMarkerValue,
  NASO_START,
  NASO_END,
} from './briefing.mjs';
import { readHook, isNasoHook, findArtifacts, CLAUDE_FILE, claudeLoadsBriefing } from './install.mjs';
import { NASO_DIR, readConfig, configuredExclusions, configPath, vendoredVersion, setupVersionOf } from './vendor.mjs';

const OK = 'OK';
const WARN = 'WARN';
const FAIL = 'FAIL';

function printRow(label, status, detail = '') {
  console.log(`${status.padEnd(5)}  ${label.padEnd(24)} ${detail}`);
}

const ESLINT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
];

/**
 * The repository's own ESLint, run on .naso/, and whatever it prints.
 *
 * Setup adds .naso/ to the config's ignores, but a config it could not edit, an opt-out, or
 * a later rewrite of the config brings the vendored files back into `eslint .`, where ESLint 9
 * reports their disable headers as unused. Running the linter is the only way to know. It is
 * run with node from node_modules/eslint, so it works the same on every platform, and only
 * when the repository has an ESLint config and an installed ESLint.
 */
async function eslintRow(cwd) {
  const configs = await Promise.all(ESLINT_CONFIGS.map((name) => pathExists(path.join(cwd, name))));
  if (!configs.some(Boolean) || !(await pathExists(path.join(cwd, NASO_DIR)))) return;
  const bin = path.join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!(await pathExists(bin))) {
    printRow(`ESLint on ${NASO_DIR}/`, OK, 'not run: ESLint is not installed in node_modules');
    return;
  }
  const res = await run(process.execPath, [bin, '--no-error-on-unmatched-pattern', `${NASO_DIR}/`], { cwd });
  const printed = `${res.stdout}\n${res.stderr}`.trim();
  if (!printed && res.ok) {
    printRow(`ESLint on ${NASO_DIR}/`, OK, 'prints nothing');
    return;
  }
  const lines = printed.split('\n');
  printRow(`ESLint on ${NASO_DIR}/`, WARN, `prints ${lines.length} line${lines.length === 1 ? '' : 's'}: ${lines[0].trim()}`);
  for (const line of lines.slice(1, 8)) if (line.trim()) console.log(`${''.padEnd(32)}${line.trim()}`);
  console.log(`${''.padEnd(32)}Add '${NASO_DIR}/' to the ESLint config's ignores (setup does it unless --no-ignore-files).`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO doctor

Usage:
  ${nasoCommand()} doctor [target-dir]

No changes are made.

Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const cwd = path.resolve(positional[0] ?? process.cwd());
  const version = await toolVersion();

  console.log(`# NASO Doctor ${version} — ${cwd}`);
  console.log('');

  printRow('Node.js', OK, process.version);
  const git = await run('git', ['--version'], { cwd });
  printRow('git', git.ok ? OK : FAIL, git.ok ? git.stdout.trim() : git.stderr.trim());

  const inWorktree = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  printRow('Inside git worktree', inWorktree.ok && inWorktree.stdout.includes('true') ? OK : WARN, inWorktree.ok ? inWorktree.stdout.trim() : 'no');

  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  printRow('Branch', branch.ok ? OK : WARN, branch.ok ? branch.stdout.trim() : 'unknown');

  const clean = await run('git', ['diff', '--name-only'], { cwd });
  const staged = await run('git', ['diff', '--cached', '--name-only'], { cwd });
  printRow('Working tree', (clean.ok && clean.stdout.trim() === '') ? OK : WARN, clean.ok && clean.stdout.trim() === '' ? 'clean' : `${clean.stdout.trim().split('\n').filter(Boolean).length} modified`);
  printRow('Staged', (staged.ok && staged.stdout.trim() === '') ? OK : WARN, staged.ok && staged.stdout.trim() === '' ? 'clean' : `${staged.stdout.trim().split('\n').filter(Boolean).length} staged`);

  const agentsPath = path.join(cwd, 'AGENTS.md');
  if (!(await pathExists(agentsPath))) {
    printRow('AGENTS.md', FAIL, 'not found');
  } else {
    const briefing = await readFile(agentsPath, 'utf8');
    const stamp = readBriefingMarkerValue(briefing, 'version');
    const hasMarkers =
      briefing.includes(NASO_START) && briefing.includes(NASO_END);
    printRow(
      'AGENTS.md',
      stamp ? OK : WARN,
      stamp
        ? `NASO ${stamp}, ${briefing.split('\n').length} lines${hasMarkers ? '' : ', no naso:start/naso:end block'}`
        : `${briefing.split('\n').length} lines (no version stamp)`,
    );
  }

  // The vendored copy is what the hook actually runs, so its absence is the single
  // most important thing this command can report.
  const vendoredVersionText = await vendoredVersion(cwd);
  // What teammates install against what the hook runs, with the command in the right
  // direction: the same note `briefing` prints. With that gap, it is the one command to run.
  const recorded = await recordedNasoVersion(cwd);
  const pinGap = recorded ? pinAdvice({ recorded, vendored: vendoredVersionText, pm: (await detectPackageManager(cwd, recorded.pkg)).name }) : null;
  if (!vendoredVersionText) {
    printRow('vendored toolset', WARN, `not found at ${NASO_DIR}/tooling/ — the hook will skip its checks`);
  } else if (compareVersions(vendoredVersionText, version) > 0) {
    printRow('vendored toolset', WARN, `${vendoredVersionText} — newer than this tool (${version}); update naso-dev`);
  } else if (vendoredVersionText !== version && !pinGap) {
    printRow('vendored toolset', WARN, `${vendoredVersionText} — behind ${version}; run \`${nasoCommand({ version })} refresh\``);
  } else {
    printRow('vendored toolset', OK, `${NASO_DIR}/tooling/ at ${vendoredVersionText}`);
  }
  if (pinGap) printRow('naso-dev in package.json', WARN, pinGap);

  const config = await readConfig(cwd);
  const excluded = configuredExclusions(config);
  printRow(
    `${NASO_DIR}/config.json`,
    (await pathExists(configPath(cwd))) ? OK : WARN,
    (await pathExists(configPath(cwd)))
      ? `setup ran with ${setupVersionOf(config) ?? 'an unrecorded version'} (refresh never rewrites it); ` +
          (excluded.length > 0 ? `${excluded.length} area(s) excluded: ${excluded.join(', ')}` : 'no areas excluded')
      : 'not written — run setup to create it',
  );

  const hookPath = path.join(cwd, '.git', 'hooks', 'pre-commit');
  const hook = await readHook(cwd);
  if (!hook) {
    // A fresh clone has everything tracked and no hook. One command installs it, and the
    // block, the toolset README and this row all name the same one.
    printRow('pre-commit hook', WARN, `missing; install it with \`${nasoCommand()} refresh\` (at the vendored version it changes nothing else)`);
  } else if (isNasoHook(hook)) {
    const pointsAt = hook.body.includes(`${NASO_DIR}/tooling/validate.mjs`);
    printRow(
      'pre-commit hook',
      pointsAt ? OK : WARN,
      pointsAt ? 'NASO hook, running the copy in this repository' : 'NASO hook, but not pointing at the vendored copy',
    );
  } else {
    printRow('pre-commit hook', WARN, 'foreign hook (left as-is)');
  }

  await eslintRow(cwd);

  try {
    const facts = await scanRepo(cwd);
    const check = await checkBriefing(cwd);
    printRow('Briefing consistency', check.ok ? OK : FAIL, `${check.tokens.length} path claims, ${check.entries.length} areas`);
    if (!check.ok) {
      for (const p of check.problems.slice(0, 3)) {
        printRow('  problem', WARN, `${p.kind}: ${p.item}`);
      }
    }
    const unknown = facts.areas.filter((e) => !e.role);
    printRow('Unnamed areas', unknown.length === 0 ? OK : WARN, unknown.length === 0 ? 'none' : `${unknown.length} area(s)`);
  } catch (e) {
    printRow('Briefing scan', FAIL, e?.message ?? String(e));
  }

  const claude = await readFile(path.join(cwd, CLAUDE_FILE), 'utf8').catch(() => null);
  if (claude === null) {
    printRow('Claude Code link', WARN, 'no CLAUDE.md — Claude Code sessions will not read AGENTS.md');
  } else if (claudeLoadsBriefing(claude)) {
    printRow('Claude Code link', OK, 'CLAUDE.md loads AGENTS.md');
  } else {
    printRow('Claude Code link', WARN, 'CLAUDE.md does not load AGENTS.md — add `@AGENTS.md` to it');
  }

  const artifacts = await findArtifacts(cwd);
  if (artifacts.length === 0) {
    printRow('Leftover NASO artifacts', OK, 'none');
  } else {
    printRow('Leftover NASO artifacts', WARN, `${artifacts.length} file(s)`);
  }

  printRow('Running tool', OK, `naso-dev ${version} from ${nasoDir()}`);

  console.log('');
  console.log('If anything is FAIL or WARN:');
  console.log(`  ${nasoCommand()} refresh ${cwd}   re-copy the toolset, move the stamp, reinstall the hook`);
  console.log(`  ${nasoCommand()} doctor ${cwd}    run this again`);
  console.log('');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev doctor: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
