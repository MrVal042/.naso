#!/usr/bin/env node
// NASO Bootstrap — wires a target repository up to this central .naso
// configuration by generating a local .agents/AGENTS.md pointer file, and
// optionally installing a pre-commit hook that runs validate.mjs.
//
// Usage:
//   node .naso/scripts/bootstrap.mjs [target-dir] [--force] [--with-hook]
//
// Zero external dependencies — Node.js core modules only.

import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists } from './lib.mjs';

const HOOK_MARKER = '# managed-by: naso bootstrap';

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg.slice(2));
    else positional.push(arg);
  }
  return { flags, target: positional[0] };
}

function buildAgentsMarkdown(nasoPathForDisplay) {
  return `# AGENTS.md

This repository is configured to use **NASO** (Next-generation AI Software Operations)
as its engineering operating system.

Central NASO directory:

\`${nasoPathForDisplay}\`

For every engineering task:

1. Load \`${nasoPathForDisplay}/context.md\`.
2. Follow its routing instructions to load only the required NASO documents.
3. Read this file for repository-specific instructions.
4. Inspect the existing code before changing anything.
5. Plan before implementing.
6. Make the smallest safe change.
7. Validate the result (see \`${nasoPathForDisplay}/scripts/validate.mjs\`).
8. Report remaining risks, then stop.

Repository instructions in this file extend NASO. They never replace it.

---

## Repository Notes

<!-- Add project-specific context, conventions, and constraints below. -->
`;
}

function buildHookScript(validateScriptPath) {
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by .naso/scripts/bootstrap.mjs — runs NASO validation before commit.
# Remove or edit this file freely; it will not be silently overwritten.

node "${validateScriptPath}"
exit $?
`;
}

async function installPreCommitHook(targetDir, validateScriptPath) {
  const gitDir = path.join(targetDir, '.git');
  if (!(await pathExists(gitDir))) {
    console.log('- Skipped git hook: no .git directory found in target.');
    return;
  }

  const hooksDir = path.join(gitDir, 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  if (await pathExists(hookPath)) {
    const existing = await readFile(hookPath, 'utf8').catch(() => '');
    if (!existing.includes(HOOK_MARKER)) {
      console.log(
        `- Skipped git hook: ${hookPath} already exists and was not created by NASO.\n` +
          `  Add this line manually to run validation before each commit:\n` +
          `  node "${validateScriptPath}"`,
      );
      return;
    }
  }

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, buildHookScript(validateScriptPath), 'utf8');
  await chmod(hookPath, 0o755);
  console.log(`- Installed pre-commit hook: ${hookPath}`);
}

async function main() {
  const { flags, target } = parseArgs(process.argv.slice(2));
  const force = flags.has('force');
  const withHook = flags.has('with-hook');

  const targetDir = path.resolve(target ?? process.cwd());
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const nasoDir = path.resolve(scriptsDir, '..');
  const validateScriptPath = path.join(scriptsDir, 'validate.mjs');

  if (!(await pathExists(targetDir))) {
    console.error(`naso bootstrap: target directory does not exist: ${targetDir}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# NASO Bootstrap — ${targetDir}`);
  console.log(`\nCentral NASO directory: ${nasoDir}`);

  const agentsDir = path.join(targetDir, '.agents');
  const agentsFile = path.join(agentsDir, 'AGENTS.md');

  // path.relative() already falls back to an absolute path itself when no
  // relative path exists (e.g. different drives on Windows). A leading ".."
  // is expected and correct for the standard sibling-workspace layout
  // (WorkSpace/.naso next to WorkSpace/ProjectX -> "../.naso").
  const relativeNasoPath = path.relative(targetDir, nasoDir);
  const displayPath = path.isAbsolute(relativeNasoPath)
    ? nasoDir
    : relativeNasoPath.startsWith('..')
      ? relativeNasoPath
      : `./${relativeNasoPath}`;

  await mkdir(agentsDir, { recursive: true });

  if ((await pathExists(agentsFile)) && !force) {
    console.log(`\n- Skipped AGENTS.md: ${agentsFile} already exists. Pass --force to overwrite.`);
  } else {
    await writeFile(agentsFile, buildAgentsMarkdown(displayPath), 'utf8');
    console.log(`\n- Wrote ${agentsFile}`);
  }

  if (withHook) {
    console.log();
    await installPreCommitHook(targetDir, validateScriptPath);
  } else {
    console.log(
      `\nTo validate automatically before each commit, either:\n` +
        `  - re-run this script with --with-hook, or\n` +
        `  - manually add this line to .git/hooks/pre-commit:\n` +
        `    node "${validateScriptPath}"`,
    );
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(`naso bootstrap: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
