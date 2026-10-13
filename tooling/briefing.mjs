#!/usr/bin/env node
// NASO Briefing — the repository scanner, the AGENTS.md writer, and the checker
// that keeps those two honest.
//
// Three views of one scan:
//
//   create   read the repository, then write AGENTS.md from nothing but what was
//            read. Every path in the output is verified to exist as it is
//            written; every sentence is either a count, a config value, or a
//            path. No placeholders, no descriptions invented from a directory's
//            name, no section kept alive only to look thorough.
//   check    does the briefing still match the repository?
//   (default = check)
//
// The rule that shapes all of it: **state only what you can read off disk.** A
// section that cannot be derived is left out rather than filled with a guess.
// That is what makes `check` able to pass on a freshly generated file with no
// human editing anything — which is the entire point, because a briefing full
// of TODO markers is a chore nobody finishes, and an unfinished briefing is
// worse than no briefing at all.
//
// Usage:
//   npx naso-dev briefing [dir]              # check (exit 1 on problems)
//   npx naso-dev briefing [dir] create       # write the NASO block
//   npx naso-dev briefing [dir] refresh      # move the version stamp only
//
// The scanner, the renderer and the checker live in scan.mjs, render.mjs and check.mjs.
// Everything they export is re-exported here, so `./briefing.mjs` stays the one import
// for every other module, and a vendored copy from before the split keeps working.
//
// Zero external dependencies — Node.js core modules only.

import {
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  parseArgs,
  compareVersions,
  isMainModule,
  toolVersion,
  banner,
  SUPPORT_EMAIL,
  nasoCommand,
} from './lib.mjs';
import {
  withLock,
} from './lock.mjs';
import {
  AGENTS_FILE,
  NASO_END,
  NASO_START,
  plural,
  scanRepo,
} from './scan.mjs';
import {
  countPhrase,
  describeEntry,
  renderBriefing,
  renderRootFiles,
} from './render.mjs';
import {
  checkBriefing,
  printCheck,
} from './check.mjs';

export * from './scan.mjs';
export * from './render.mjs';
export * from './check.mjs';

/**
 * Write the NASO block into AGENTS.md, under the repo lock, without ever touching
 * anything a person wrote.
 *
 * Four cases, and the differences between them are the whole point:
 *
 *   no file            write the block as the whole file
 *   file, no markers   append the block below what is there, byte for byte
 *   file, markers     replace only what is between them — and only with --force
 *   --force            never reaches outside the markers, whatever else it does
 *
 * The 2.x behaviour — "AGENTS.md exists, so overwrite it" — is gone. A 193-line
 * hand-written AGENTS.md is not a stale cache entry, and a tool that deletes it on
 * setup is a tool nobody runs twice. `--force` now means exactly one thing: replace
 * the block between the markers. It is not, and cannot be, permission to rewrite the file.
 *
 * Generation re-reads the repository inside the lock and re-renders from what it
 * finds there, so two concurrent setups produce one of two complete briefings
 * rather than a half-written file.
 */
export async function createBriefing(cwd, { force = false, exclude = null } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);

  const version = await toolVersion();
  const now = new Date().toISOString().slice(0, 10);

  const outcome = await withLock(
    cwd,
    async () => {
      const before = await readFile(agentsPath, 'utf8').catch(() => null);
      const existingLines = before === null ? 0 : before.split('\n').length;

      const facts = await scanRepo(cwd, { exclude });
      const block = await renderBriefing(facts, { version, now });

      if (before === null) {
        await writeFile(agentsPath, block, 'utf8');
        return { ok: true, appended: false, agentsPath, content: block, facts };
      }

      const start = before.indexOf(NASO_START);
      const end = before.indexOf(NASO_END);

      if (start === -1 || end === -1 || end < start) {
        // No block of ours in the file: append one and keep every existing line.
        const appended = appendBlock(before, block);
        await writeFile(agentsPath, appended, 'utf8');
        return { ok: true, appended: true, existingLines, agentsPath, content: appended, facts };
      }

      if (!force) {
        return { ok: false, reason: 'has-block', agentsPath, existingLines };
      }

      const replaced =
        before.slice(0, start) + block.trimEnd() + before.slice(end + NASO_END.length);
      await writeFile(agentsPath, replaced, 'utf8');
      return {
        ok: true,
        appended: false,
        replacedBlock: true,
        existingLines,
        agentsPath,
        content: replaced,
        facts,
      };
    },
    {
      reason: 'write the AGENTS.md briefing',
      onBusy: (holder) => {
        console.log(`  ! ${AGENTS_FILE} is locked by ${holder}; skipped the write.`);
      },
    },
  );

  return outcome.ok ? outcome.value : { ok: false, reason: 'locked', holder: outcome.holder };
}

/**
 * A hand-written AGENTS.md with the NASO block appended, every existing byte kept.
 *
 * One function for the write and for the plan's line count, so the preview cannot
 * disagree with the file about how much was added.
 */
export function appendBlock(before, block) {
  const separator =
    before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${block}`;
}

/** Read one of the machine-readable header markers, or null when absent. */
export function readBriefingMarkerValue(content, field) {
  const pattern = new RegExp(`^<!--\\s*${field}:\\s*(.+?)\\s*-->$`, 'm');
  return content.match(pattern)?.[1] ?? null;
}

/**
 * Move the `<!-- version: X -->` stamp, and nothing else in the file.
 *
 * Used by `refresh`, whose whole promise is that a briefing somebody spent twenty minutes
 * on survives a version bump. Only the stamp line is rewritten; every other byte is
 * written back untouched.
 *
 * The stamp only ever moves forward. A briefing generated by a newer NASO than the tool
 * asking is reported and left alone: rewriting it would erase the only evidence that the
 * tool — not the briefing — needs updating.
 */
export async function refreshBriefingStamp(cwd, { current } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (!(await pathExists(agentsPath))) {
    return { ok: false, reason: 'missing', agentsPath };
  }

  const version = current ?? (await toolVersion());
  const content = await readFile(agentsPath, 'utf8');
  const stamped = readBriefingMarkerValue(content, 'version');

  if (!stamped) {
    return { ok: false, reason: 'unstamped', agentsPath };
  }
  if (stamped === version || compareVersions(stamped, version) > 0) {
    return { ok: true, changed: false, agentsPath, version, previous: stamped };
  }

  await writeFile(
    agentsPath,
    content.replace(/^<!--\s*version:\s*.+?\s*-->$/m, `<!-- version: ${version} -->`),
    'utf8',
  );
  return { ok: true, changed: true, agentsPath, version, previous: stamped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`NASO briefing

Usage:
  ${nasoCommand()} briefing [dir]                    check the briefing against the repo
  ${nasoCommand()} briefing [dir] check              same
  ${nasoCommand()} briefing [dir] create             write the NASO block into AGENTS.md
  ${nasoCommand()} briefing [dir] create --force     replace an existing naso:start/naso:end block
  ${nasoCommand()} briefing [dir] refresh            move the version stamp only

Never rewrites anything outside <!-- naso:start --> and <!-- naso:end -->.

Exit codes: 0 clean, 1 problems found or the write was refused.
Support: ${SUPPORT_EMAIL}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }

  const [maybeCommand, ...rest] = positional;
  const COMMANDS = new Set(['check', 'create', 'refresh']);

  // The verb and the directory may come in either order. A positional that
  // matches a verb *and* names a directory that exists is a directory, so a repo
  // literally called `create` still works when named as `./create`.
  const isVerb = async (token) => COMMANDS.has(token) && !(await pathExists(path.resolve(token)));
  let command = 'check';
  let cwd;

  if (await isVerb(maybeCommand)) {
    command = maybeCommand;
    cwd = path.resolve(rest[0] ?? process.cwd());
  } else {
    cwd = path.resolve(maybeCommand ?? process.cwd());
  }
  for (const token of positional) {
    if (await isVerb(token)) command = token;
  }

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev briefing: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  if (command === 'create') {
    const result = await createBriefing(cwd, { force: flags.has('force') });
    if (!result.ok) {
      if (result.reason === 'has-block') {
        console.log(
          `- ${AGENTS_FILE} already has a naso:start / naso:end block. Left it exactly as it is.\n` +
            '  Re-run with --force to replace just that block. Nothing outside the markers\n' +
            '  is ever rewritten, with or without --force.',
        );
      } else {
        console.log(`- Skipped ${AGENTS_FILE}: locked by ${result.holder}.`);
      }
      process.exitCode = 1;
      return;
    }

    banner('Briefing', result.agentsPath);
    console.log(
      result.appended
        ? `Appended the NASO block below the ${plural(result.existingLines, 'line')} already in ${AGENTS_FILE}. Nothing existing was changed.`
        : result.replacedBlock
          ? `Replaced the naso:start / naso:end block. The other ${plural(result.existingLines, 'line')} of ${AGENTS_FILE} are byte for byte as you left them.`
          : `Wrote ${AGENTS_FILE} from ${countPhrase(result.facts)}.`,
    );
    console.log('');
    for (const entry of result.facts.areas) {
      console.log(`  ${describeEntry(entry)}`);
    }
    const rootFiles = renderRootFiles(result.facts.entries, result.facts);
    if (rootFiles) {
      console.log('');
      console.log(`  ${rootFiles.split('\n').join('\n  ')}`);
    }
    console.log('');
    const verified = await checkBriefing(cwd);
    printCheck(verified);
    if (!verified.ok) process.exitCode = 1;
    return;
  }

  if (command === 'refresh') {
    const result = await refreshBriefingStamp(cwd);
    if (!result.ok) {
      console.log(
        result.reason === 'missing'
          ? `- No ${AGENTS_FILE} in ${cwd} yet. Run \`naso setup\` to create it.`
          : `- No version stamp found in ${AGENTS_FILE}; nothing changed.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!result.changed) {
      if (compareVersions(result.previous, result.version) > 0) {
        console.log(
          `- ${AGENTS_FILE} was written by a newer NASO (${result.previous}); this tool is ${result.version}. ` +
            `Update naso-dev rather than downgrading the briefing.`,
        );
      } else {
        console.log(`- ${AGENTS_FILE} is already stamped ${result.version} — nothing to refresh.`);
      }
      return;
    }
    console.log(`- Refreshed ${AGENTS_FILE} version stamp: ${result.previous} -> ${result.version}`);
    console.log('  Briefing content untouched.');
    return;
  }

  banner('Briefing Check', cwd);
  const result = await checkBriefing(cwd);
  printCheck(result);
  if (!result.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev briefing: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
