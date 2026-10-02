#!/usr/bin/env node
// NASO command-line entry point.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toolVersion, SUPPORT_EMAIL } from '../tooling/lib.mjs';

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tooling');

const COMMANDS = {
  init: { module: 'init.mjs', blurb: 'Step 1 — what NASO does here and why, then the next command' },
  setup: { module: 'setup.mjs', blurb: 'Steps 2-6 — scan, confirm, write AGENTS.md + vendored tooling, verify' },
  briefing: { module: 'briefing.mjs', blurb: 'Regenerate or re-verify the AGENTS.md briefing' },
  refresh: { module: 'refresh.mjs', blurb: 'Re-vendor the tooling, move the version stamp, reinstall the hook' },
  guide: { module: 'guide.mjs', blurb: 'Guide for one area, or --tour for a read-through of the whole briefing' },
  validate: { module: 'validate.mjs', blurb: 'Pre-commit gate: secrets, scope, format, lint, briefing' },
  doctor: { module: 'doctor.mjs', blurb: 'Diagnose the environment and the install' },
};

async function usage() {
  console.log(`NASO ${await toolVersion()}\n`);
  console.log('Usage: naso-dev <command> [target-dir] [options]\n');
  for (const [name, meta] of Object.entries(COMMANDS)) {
    console.log(`  naso-dev ${name.padEnd(9)} ${meta.blurb}`);
  }
  console.log(`\nEvery command accepts --help. Support: ${SUPPORT_EMAIL}`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    await usage();
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(await toolVersion());
    return;
  }

  const command = argv[0];
  const entry = COMMANDS[command];

  if (!entry) {
    console.error(`naso-dev: unknown command '${command}'.`);
    console.error(`Known commands: ${Object.keys(COMMANDS).join(', ')}.\n`);
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
