#!/usr/bin/env node
// NASO Bootstrap — wires a target repository up to this central .naso
// configuration by generating pointer files at the paths different AI
// tools discover automatically (root CLAUDE.md, .agents/AGENTS.md), and
// optionally installing a pre-commit hook that runs validate.mjs --staged.
//
// Both pointer files carry identical content — ai/model-behavior.md's
// "Model Independence" principle is that NASO behaves the same regardless
// of which model or tool reads it, so only the file's location should vary
// by tool convention, never the instructions themselves.
//
// By default, bootstrap artifacts are excluded from the target repo's git
// tracking via .git/info/exclude — not a committed .gitignore entry — so
// nothing personal is ever pushed into a repository the operator does not
// own (client/contract work). Pass --track to commit .agents/ instead, for
// repos the operator owns and wants to share the setup in.
//
// Usage:
//   node .naso/scripts/bootstrap.mjs [target-dir] [--force] [--with-hook] [--track]
//
// Zero external dependencies — Node.js core modules only.

import { mkdir, writeFile, readFile, appendFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathExists, parseArgs } from './lib.mjs';

const HOOK_MARKER = '# managed-by: naso bootstrap';
const EXCLUDE_MARKER = '# added by naso bootstrap';

function buildPointerMarkdown(nasoPathForDisplay) {
  return `# NASO

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

/** Write a pointer file unless it already exists and --force wasn't passed. */
async function writePointerFile(filePath, content, force) {
  if ((await pathExists(filePath)) && !force) {
    console.log(`- Skipped ${filePath}: already exists. Pass --force to overwrite.`);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  console.log(`- Wrote ${filePath}`);
}

function buildHookScript(validateScriptPath, guardScriptPath) {
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by .naso/scripts/bootstrap.mjs — runs NASO validation before commit.
# Remove or edit this file freely; it will not be silently overwritten.

# Warn-only: always prints, never blocks the commit on its own.
node "${guardScriptPath}" --staged

# Blocking: staged lint/format/branch-name checks.
node "${validateScriptPath}" --staged
exit $?
`;
}

/** Add patterns to .git/info/exclude (local-only, never committed) if not already present. */
async function excludeLocally(targetDir, patterns) {
  const gitDir = path.join(targetDir, '.git');
  if (!(await pathExists(gitDir))) return false;

  const excludeDir = path.join(gitDir, 'info');
  const excludePath = path.join(excludeDir, 'exclude');
  const existing = await readFile(excludePath, 'utf8').catch(() => '');

  const missing = patterns.filter((pattern) => !existing.includes(pattern));
  if (missing.length === 0) return true;

  await mkdir(excludeDir, { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(excludePath, `${prefix}\n${EXCLUDE_MARKER}\n${missing.join('\n')}\n`, 'utf8');
  return true;
}

async function installPreCommitHook(targetDir, validateScriptPath, guardScriptPath) {
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
          `  Add these lines manually to run validation before each commit:\n` +
          `  node "${guardScriptPath}" --staged\n` +
          `  node "${validateScriptPath}" --staged`,
      );
      return;
    }
  }

  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, buildHookScript(validateScriptPath, guardScriptPath), 'utf8');
  await chmod(hookPath, 0o755);
  console.log(`- Installed pre-commit hook: ${hookPath}`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const force = flags.has('force');
  const withHook = flags.has('with-hook');
  const track = flags.has('track');

  const targetDir = path.resolve(positional[0] ?? process.cwd());
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const nasoDir = path.resolve(scriptsDir, '..');
  const validateScriptPath = path.join(scriptsDir, 'validate.mjs');
  const guardScriptPath = path.join(scriptsDir, 'guard.mjs');

  if (!(await pathExists(targetDir))) {
    console.error(`naso bootstrap: target directory does not exist: ${targetDir}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# NASO Bootstrap — ${targetDir}`);
  console.log(`\nCentral NASO directory: ${nasoDir}`);

  const agentsFile = path.join(targetDir, '.agents', 'AGENTS.md');
  const claudeFile = path.join(targetDir, 'CLAUDE.md');

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

  const pointerContent = buildPointerMarkdown(displayPath);
  console.log();
  await writePointerFile(agentsFile, pointerContent, force);
  await writePointerFile(claudeFile, pointerContent, force);

  if (track) {
    console.log(
      '- --track passed: pointer files are left for the repo\'s normal git tracking. Add and commit them yourself if you want the setup shared.',
    );
  } else {
    const excluded = await excludeLocally(targetDir, ['.agents/', 'CLAUDE.md']);
    console.log(
      excluded
        ? '- Excluded .agents/ and CLAUDE.md from git tracking locally (.git/info/exclude), so nothing is committed into this repo\'s history. Pass --track to commit them instead.'
        : '- No .git directory found in target; skipped local exclude.',
    );
  }

  if (withHook) {
    console.log();
    await installPreCommitHook(targetDir, validateScriptPath, guardScriptPath);
  } else {
    console.log(
      `\nTo validate automatically before each commit, either:\n` +
        `  - re-run this script with --with-hook, or\n` +
        `  - manually add these lines to .git/hooks/pre-commit:\n` +
        `    node "${guardScriptPath}" --staged\n` +
        `    node "${validateScriptPath}" --staged`,
    );
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(`naso bootstrap: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
