#!/usr/bin/env node
// NASO Init — step 1 of the documented setup, and the only step that is
// guaranteed to change nothing.
//
// It reads the repository, explains what step 2 is about to do and why it is
// worth doing, and prints the command to run next. It writes no file, installs
// no hook, and edits no git config. That is the whole design: the decision to
// adopt NASO belongs to the person reading the output, so the step that asks for
// it must not have already changed their repository.
//
// It is also the step that has to be safe to run twice, in the wrong directory,
// on a repository that already has a briefing, and on something that is not a
// git repository at all. Each of those is reported, not acted on.
//
// Usage:
//   npx naso-dev init [target-dir] [--track] [--no-hook]
//
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  pathExists,
  parseArgs,
  run,
  toolVersion,
  actorIdentity,
  nasoDir,
  isMainModule,
  TOOLS,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { topLevelEntries, areasOf, dominantLanguage, splitNul } from './briefing.mjs';
import { readHook, isNasoHook } from './install.mjs';
import { NASO_DIR, isVendored, vendoredVersion } from './vendor.mjs';

const AGENTS_FILE = 'AGENTS.md';

/**
 * A short, honest description of what is already here.
 *
 * Every branch is a fact about the filesystem. Nothing is inferred about whether
 * the user wants any of it — that is step 2's question to ask.
 */
async function describeCurrentState(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  const hasBriefing = await pathExists(agentsPath);

  let stampedVersion = null;
  if (hasBriefing) {
    const content = await readFile(agentsPath, 'utf8').catch(() => '');
    stampedVersion = content.match(/^<!--\s*version:\s*(.+?)\s*-->$/m)?.[1] ?? null;
  }

  const hook = await readHook(cwd);
  const vendored = await isVendored(cwd);
  const vendoredAt = await vendoredVersion(cwd);

  return {
    hasBriefing,
    stampedVersion,
    vendored,
    vendoredVersion: vendoredAt,
    hookInstalled: isNasoHook(hook),
    hookPath: hook?.path ?? null,
    hookForeign: Boolean(hook) && !isNasoHook(hook),
  };
}

async function describeRepository(cwd) {
  const isRepo = (await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })).ok;
  if (!isRepo) return { isRepo: false };

  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const filesRes = await run('git', ['ls-files', '-c', '-o', '--exclude-standard'], { cwd });
  const files = filesRes.ok
    ? filesRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    : [];

  const entries = topLevelEntries(files);
  const language = dominantLanguage(files);

  return {
    isRepo: true,
    branch: branchRes.ok ? branchRes.stdout.trim() : null,
    files: files.length,
    areas: entries.filter((entry) => entry.isDir).map((entry) => entry.name),
    rootFiles: entries.filter((entry) => !entry.isDir).length,
    language,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO init

Usage:
  npx naso-dev init [target-dir] [--track] [--no-hook]

Reads the repository and prints what step 2 will do. Writes nothing.

  --track    mention --track in the step-2 command (commit the briefing files
             instead of keeping them out of git locally)
  --no-hook  mention --no-hook in the step-2 command (skip the pre-commit hook)

Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const cwd = path.resolve(positional[0] ?? process.cwd());
  const track = flags.has('track');
  const noHook = flags.has('no-hook');

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev init: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const version = await toolVersion();
  const actor = actorIdentity();
  const gitVersion = await run('git', ['--version']);

  console.log(`# NASO Init ${version} — ${cwd}`);
  console.log('');
  console.log(`Tool directory:  ${nasoDir()}`);
  console.log(`Node:            ${process.version}`);
  console.log(`Git:             ${gitVersion.ok ? gitVersion.stdout.trim() : 'not found on PATH'}`);
  console.log(`Run by:          ${actor}`);
  console.log('');

  // --- Already installed? Say so before explaining the setup from scratch. ---
  const state = await describeCurrentState(cwd);
  const repo = await describeRepository(cwd);

  console.log('## This repository');
  console.log('');
  if (!repo.isRepo) {
    console.log('Not a git repository. NASO still works on one, but two of its four');
    console.log('tools — the pre-commit hook and the scope check — need git, and the');
    console.log('briefing would have nothing to check itself against.');
  } else {
    console.log(`Branch:    ${repo.branch ?? 'unknown'}`);
    console.log(`Files:     ${repo.files} this repository tracks`);
    console.log(`Areas:     ${repo.areas.length} top-level director${repo.areas.length === 1 ? 'y' : 'ies'}${repo.areas.length ? ` (${repo.areas.slice(0, 10).join(', ')}${repo.areas.length > 10 ? ', ...' : ''})` : ''}`);
    if (repo.language) {
      console.log(`Language:  ${repo.language.label}, ${repo.language.count} of ${repo.files} files`);
    }
  }
  console.log('');

  if (state.hasBriefing || state.vendored || state.hookInstalled || state.hookForeign) {
    console.log('## Already set up');
    console.log('');
    if (state.hasBriefing) {
      console.log(
        `- ${AGENTS_FILE} exists${state.stampedVersion ? `, generated by NASO ${state.stampedVersion}` : ', with no NASO version stamp'}.`,
      );
      console.log('  Check it still matches the code:  npx naso-dev briefing .');
      console.log('  Read the guide for one area:    npx naso-dev guide . <area>');
    }
    if (state.vendored) {
      console.log(
        `- The toolset is vendored at ${NASO_DIR}/tooling/${state.vendoredVersion ? `, copied from ${state.vendoredVersion}` : ''}.`,
      );
      console.log('  Bring it up to date:            npx naso-dev refresh .');
    }
    if (state.hookInstalled) {
      console.log(`- The pre-commit hook is installed at ${state.hookPath}.`);
      console.log('  Inspect it:                     npx naso-dev doctor .');
    }
    if (state.hookForeign) {
      console.log(`- ${state.hookPath} exists and was NOT written by NASO.`);
      console.log('  Step 2 will leave it alone rather than replacing it.');
    }
    console.log('');
    console.log('Re-run setup if you want the NASO block in AGENTS.md regenerated:');
    console.log(`  npx naso-dev setup${noHook ? ' --no-hook' : ''}${track ? ' --track' : ''} ${cwd}`);
    console.log('');
    return;
  }

  // --- The explanation. This is the entire point of the step. ---
  console.log('## What step 2 does');
  console.log('');
  console.log('One-time setup, once per repository. It is two commands and then you never');
  console.log('run them again:');
  console.log('');
  console.log(`  1. Reads this repository and shows you what it found — the areas, the`);
  console.log(`     entry points, the validation commands — and the tools it will give`);
  console.log(`     you. Then it asks you to accept or reject.`);
  console.log(`  2. On accept, writes ${AGENTS_FILE} from what it read, copies the toolset`);
  console.log(`     into ${NASO_DIR}/tooling/, installs the pre-commit hook, and deletes`);
  console.log(`     anything left over from an earlier attempt. On reject it writes nothing,`);
  console.log(`     re-reads the repository, and shows you the plan again.`);
  console.log('');
  console.log('An AGENTS.md you already wrote is never replaced. The NASO block goes between');
  console.log('<!-- naso:start --> and <!-- naso:end -->, and everything you wrote stays.');
  console.log('');
  console.log('Tools you get:');
  for (const tool of TOOLS) {
    console.log(`  ${tool.name.padEnd(9)} ${tool.blurb}`);
  }
  console.log('');
  console.log(`The toolset lives in this repository at ${NASO_DIR}/tooling/. The hook runs that`);
  console.log('copy, so it keeps working on a machine that has never heard of this package,');
  console.log('and after the npx cache is cleared.');
  console.log('');

  console.log('## Why it matters');
  console.log('');
  console.log('An AI coding agent starts every session knowing nothing about your');
  console.log('repository. Without a briefing it explores blind, guesses at architecture,');
  console.log('and confidently invents files that were never there — and because the');
  console.log('answer sounds authoritative, it is trusted. That costs more time than the');
  console.log('briefing takes to write.');
  console.log('');
  console.log(`${AGENTS_FILE} answers the questions an agent would otherwise spend a`);
  console.log('whole session rediscovering: what each area is for, where it lives, and');
  console.log('what must pass before the work counts as done. NASO writes it by reading');
  console.log('the repository, so it starts out true rather than aspirational, and the');
  console.log('pre-commit hook keeps it true by refusing commits that leak a secret or');
  console.log('drift outside the scope you claimed.');
  console.log('');
  console.log('Nothing is written until you accept at step 2. Declining twice is a valid');
  console.log('answer and leaves this repository exactly as it is.');
  console.log('');

  // --- The next command. Concrete, copy-pasteable, carrying your flags. ---
  const nextFlags = [noHook ? '--no-hook' : '', track ? '--track' : '']
    .filter(Boolean)
    .join(' ');

  console.log('## Next');
  console.log('');
  console.log(`  npx naso-dev setup${nextFlags ? ` ${nextFlags}` : ''} ${cwd}`);
  console.log('');
  console.log(
    `Equivalent, without the package:  node ${path.join(nasoDir(), 'tooling', 'setup.mjs')}` +
      `${nextFlags ? ` ${nextFlags}` : ''} ${cwd}`,
  );
  console.log('');
  console.log(`Prefer to look before you decide?  npx naso-dev doctor ${cwd}`);
  console.log('');
  console.log('Before you accept, setup copies these scripts into this repository under');
  console.log('.naso/tooling/ so the pre-commit hook keeps working without the package.');
  console.log('');
  console.log(`Support: ${SUPPORT_EMAIL}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev init: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
