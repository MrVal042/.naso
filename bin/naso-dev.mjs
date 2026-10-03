#!/usr/bin/env node
// NASO command-line entry point.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toolVersion, SUPPORT_EMAIL, pathExists } from '../tooling/lib.mjs';

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tooling');

const COMMANDS = {
  briefing: { module: 'briefing.mjs', blurb: 'Regenerate or re-verify the AGENTS.md briefing' },
  refresh: { module: 'refresh.mjs', blurb: 'Re-vendor the tooling, move the version stamp, reinstall the hook' },
  guide: { module: 'guide.mjs', blurb: 'Guide for one area, or --tour for a read-through of the whole briefing' },
  validate: { module: 'validate.mjs', blurb: 'Pre-commit gate: secrets, scope, format, lint, briefing' },
  doctor: { module: 'doctor.mjs', blurb: 'Diagnose the environment and the install' },
};

// Retired, still functional. Scripts in the wild call these, and a deprecation
// that breaks them is a deprecation nobody can roll back, so they run exactly as
// before and say one line about what replaced them.
const RETIRED = {
  init: { module: 'init.mjs', replacement: 'npx naso-dev' },
  setup: { module: 'setup.mjs', replacement: 'npx naso-dev' },
};

async function usage() {
  console.log(`NASO ${await toolVersion()}\n`);
  console.log('Usage: naso-dev [target-dir] [options]\n');
  console.log('  naso-dev             Set up NASO here: read the repository, show the plan,');
  console.log('                       ask, then write. This is the only command most people');
  console.log('                       ever need, and it is safe to run from a script.');
  console.log('');
  console.log('Other commands:');
  for (const [name, meta] of Object.entries(COMMANDS)) {
    console.log(`  naso-dev ${name.padEnd(9)} ${meta.blurb}`);
  }
  console.log('');
  console.log('Every command accepts --help. Support: ' + SUPPORT_EMAIL);
}

async function main() {
  const argv = process.argv.slice(2);

  // No arguments at all is the setup flow, not a help screen. `npx naso-dev` on its
  // own is the command the README tells people to type, and printing a list of
  // commands there would make the documented entry point do nothing.
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    await usage();
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(await toolVersion());
    return;
  }

  const command = argv[0];
  const retired = RETIRED[command];

  if (retired) {
    console.error(`naso-dev ${command}: deprecated — \`${retired.replacement}\` now does this and the setup in one run.`);
    console.error(`naso-dev ${command} still works; this notice is the only change.\n`);
    const mod = await import(pathToFileURL(path.join(TOOL_DIR, retired.module)).href);
    await mod.main(argv.slice(1));
    return;
  }

  const entry = COMMANDS[command];

  // No command, or a path that is not one: the flow. This is the branch that
  // makes `npx naso-dev` do the whole job, and it is taken before the unknown-
  // command path so that a typo is still reported as a typo but a directory is
  // treated as the directory the user meant.
  // A first argument that exists on disk is a directory, not a command name, even
  // when it is relative and does not start with a dot: `naso-dev packages/api` is a
  // real thing somebody types and must not be reported as a typo. A leading dash is
  // a flag for the flow, for the same reason: `naso-dev --yes` sets up here.
  const targetish =
    command !== undefined &&
    (command.startsWith('-') ||
      path.isAbsolute(command) ||
      command.startsWith('.') ||
      command.startsWith('~') ||
      (await pathExists(command)));
  const looksLikeCommand = !entry && command !== undefined && !targetish;
  if (!entry && !looksLikeCommand) {
    const mod = await import(pathToFileURL(path.join(TOOL_DIR, 'flow.mjs')).href);
    await mod.main(argv);
    return;
  }

  if (looksLikeCommand) {
    console.error(`naso-dev: unknown command '${command}'.`);
    console.error(`Known commands: ${Object.keys(COMMANDS).join(', ')}.\n`);
    console.error('With no command, naso-dev sets NASO up in the current directory.\n');
    await usage();
    process.exitCode = 1;
    return;
  }

  const mod = await import(pathToFileURL(path.join(TOOL_DIR, entry.module)).href);
  await mod.main(argv.slice(1));
}

main().catch((err) => {
  console.error(`naso-dev: unexpected error — ${err?.stack ?? err}`);
  console.error(`Support: ${SUPPORT_EMAIL}`);
  process.exitCode = 1;
});
