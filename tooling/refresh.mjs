#!/usr/bin/env node
// NASO Refresh — bring an already-set-up repository up to the current tool.
//
// Three things, and deliberately not a fourth:
//
//   1. Re-copy the toolset into `<repo>/.naso/tooling/`, with this version's VERSION.
//   2. Move the AGENTS.md version stamp forward — the stamp only, never a word of prose.
//   3. Reinstall the pre-commit hook, so it points at the freshly copied scripts.
//
// What it will not do, and the reason is the whole design of this command:
//
//   It never rewrites AGENTS.md content. A briefing somebody spent twenty minutes on, or
//   an agent added a section to, is theirs; a version bump is not a licence to throw that
//   away. If the content needs regenerating, that is `briefing create --force`.
//
//   It never rewrites `.naso/config.json`. That file records decisions a human made about
//   this repository — which areas stay out of the briefing, local or tracked mode. An
//   upgrade is not a reason to re-ask those questions.
//
// The stamp only ever moves forward. A briefing written by a newer NASO than the tool
// running the refresh is reported and left alone: downgrading the stamp would destroy the
// only record that the tool, not the briefing, is out of date.
//
// Usage:
//   npx naso-dev refresh [target-dir]
//
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import {
  parseArgs,
  pathExists,
  toolVersion,
  compareVersions,
  isMainModule,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { refreshBriefingStamp, AGENTS_FILE } from './briefing.mjs';
import { installPreCommitHook, readHook, isNasoHook } from './install.mjs';
import { NASO_DIR, isVendored, vendorTooling, vendoredVersion, readConfig } from './vendor.mjs';

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO refresh

Usage:
  npx naso-dev refresh [target-dir]

  Re-copies the toolset into ${NASO_DIR}/tooling/, moves the AGENTS.md version stamp
  forward, and reinstalls the pre-commit hook.

  Never rewrites AGENTS.md prose and never rewrites ${NASO_DIR}/config.json.
  To regenerate the briefing itself: npx naso-dev briefing <dir> create --force

Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev refresh: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const version = await toolVersion();
  console.log(`# NASO Refresh ${version} — ${cwd}`);
  console.log('');

  const hadTooling = await isVendored(cwd);
  const hadBriefing = await pathExists(path.join(cwd, AGENTS_FILE));

  if (!hadTooling && !hadBriefing) {
    console.log('This repository is not set up yet. Nothing to refresh.');
    console.log('');
    console.log(`  npx naso-dev setup ${cwd}`);
    console.log('');
    process.exitCode = 1;
    return;
  }

  let problems = 0;

  // 1. The toolset.
  const vendored = await vendorTooling(cwd, { version });
  console.log(`OK  Re-copied ${vendored.length} files into ${NASO_DIR}/tooling/.`);
  if (!hadTooling) {
    console.log('    It was not there before, so this run set the repository up as well.');
  }

  // 2. The stamp. Forward only.
  if (!hadBriefing) {
    console.log(`--  No ${AGENTS_FILE} here, so there is no stamp to move.`);
    console.log(`    The gate still works; run \`npx naso-dev setup ${cwd}\` for the briefing.`);
  } else {
    const stamped = await refreshBriefingStamp(cwd, { current: version });
    if (!stamped.ok) {
      if (stamped.reason === 'unstamped') {
        console.log(`--  ${AGENTS_FILE} has no version stamp, so nothing to move.`);
        console.log(`    \`npx naso-dev briefing ${cwd} create --force\` would write one.`);
      } else {
        console.log(`--  Could not read ${AGENTS_FILE}: ${stamped.reason}`);
        problems++;
      }
    } else if (!stamped.changed) {
      console.log(`--  ${AGENTS_FILE} is already stamped ${version}.`);
    } else if (compareVersions(stamped.previous, version) > 0) {
      console.log(`--  ${AGENTS_FILE} is stamped ${stamped.previous}, newer than this tool (${version}).`);
      console.log('    Left it alone: the tool is what needs updating here, not the briefing.');
      console.log('    Run `npm install -g naso-dev` or `npm update naso-dev` to catch up.');
    } else {
      console.log(`OK  Moved the ${AGENTS_FILE} stamp ${stamped.previous} -> ${version}. No prose touched.`);
    }
  }

  // 3. The hook.
  const hook = await readHook(cwd);
  if (hook && !isNasoHook(hook)) {
    console.log(`--  ${hook.path} is a hook NASO did not write. Left it as it is.`);
  } else {
    const installed = await installPreCommitHook(cwd, { report: () => {} });
    if (installed.ok) {
      console.log(`OK  Reinstalled the pre-commit hook: ${installed.hookPath}`);
    } else {
      console.log(`--  Skipped the pre-commit hook: ${installed.reason}.`);
      console.log(`    To run the gate by hand: node ${NASO_DIR}/tooling/validate.mjs --staged`);
    }
  }

  // Reported, never rewritten.
  const config = await readConfig(cwd);
  const excluded = Array.isArray(config.exclude) ? config.exclude : [];
  console.log('');
  console.log(`   ${NASO_DIR}/config.json: left exactly as it was`);
  console.log(
    excluded.length > 0
      ? `   ${excluded.length} area(s) excluded from the briefing: ${excluded.join(', ')}`
      : '   no areas excluded from the briefing',
  );

  console.log('');
  console.log(`Toolset version in this repository: ${(await vendoredVersion(cwd)) ?? version}`);
  console.log('');
  console.log('Next:');
  console.log(`  npx naso-dev doctor ${cwd}       confirm the install end to end`);
  console.log(`  npx naso-dev validate ${cwd}     run the full gate once, not just the staged one`);
  console.log('');

  if (problems > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev refresh: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
