#!/usr/bin/env node
// NASO Guide — read the briefing back against the code and say what to do next.
//
// `briefing` answers "is the briefing true?". `guide` answers "what do I do with
// it?", which is the question a briefing cannot answer about itself: it is the
// thing being described, so it has no room to describe how to read it.
//
// Three things, and the third is the one worth keeping:
//
//   1. `guide <area>` — everything about one area on one screen: what it is, how
//      big it is, what has to pass, and the scope line to export. The briefing is
//      a map of the whole repository; a task is one area, and a map is the wrong
//      shape for that.
//   2. Drift: the same check the pre-commit hook enforces, run on demand.
//   3. `guide --tour` — the section-by-section walkthrough, for a person who has
//      just inherited a repository and needs the orientation an agent gets.
//
// Nothing is written. A guide that edited what it was describing would be a worse
// guide than no guide.
//
// Usage:
//   npx naso-dev guide <area-or-prefix> [target-dir]
//   npx naso-dev guide --tour [target-dir]
//
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  parseArgs,
  run,
  toolVersion,
  compareVersions,
  isMainModule,
  SUPPORT_EMAIL,
} from './lib.mjs';
import {
  scanRepo,
  checkBriefing,
  readBriefingMarkerValue,
  listRepoFiles,
  describeEntry,
  humanize,
  plural,
} from './briefing.mjs';

/** Sections worth walking through, and why each one earns its place. */
const SECTION_NOTES = [
  ['Project Structure', 'what each area of this repository is for, and where it lives'],
  ['Feature To Folder Map', 'which folder owns which capability, for when a task names a feature'],
  [
    'Code Conventions',
    'the rules and the validation commands a new contributor would otherwise learn by making the mistake',
  ],
  ['Scope', 'the prefixes to claim before editing, so the hook can check the diff'],
  ['Boundaries', 'the lines that are easy to cross without noticing'],
  ['Secrets', 'never print a credential, even accidentally'],
  ['Commit Standard', 'how a change is expected to be shaped and described'],
  ['Final Response Expectations', 'what a finished answer has to contain'],
];

/** Pull the sections out of the briefing, keeping only the ones actually present. */
function readSections(briefing) {
  const parts = briefing
    .split(/^##\s+/m)
    .slice(1)
    .map((chunk) => {
      const newline = chunk.indexOf('\n');
      return { title: chunk.slice(0, newline).trim(), body: chunk.slice(newline + 1) };
    });

  return parts.map((part) => ({
    ...part,
    note: SECTION_NOTES.find(([title]) => title === part.title)?.[1] ?? null,
    bodyLines: part.body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length,
  }));
}

function printWalkthrough(briefing) {
  const sections = readSections(briefing);

  console.log('## The briefing, in reading order');
  console.log('');

  const intro = briefing.match(/^#\s+(.+)$/m)?.[1];
  if (intro) console.log(`  ${intro}`);
  console.log('');

  for (const section of sections) {
    const heading = section.title.replace(/^#+\s*/, '');
    const bullets = section.body
      .split('\n')
      .filter((line) => /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line))
      .length;

    console.log(`  ${heading}`);
    if (section.note) console.log(`      why: ${section.note}`);
    if (section.bodyLines <= 2) {
      console.log('      note: nothing under this heading. Empty is the one thing the briefing');
      console.log('            was rebuilt to avoid — check it is meant to be empty.');
    }
    if (bullets > 0) {
      console.log(`      ${plural(bullets, 'line')} of specifics`);
    }
    console.log('');
  }

  if (sections.length === 0) {
    console.log('  The briefing has no sections yet.');
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// One area on one screen
// ---------------------------------------------------------------------------

/**
 * The scope prefix for an area, as a shell line ready to paste.
 *
 * PowerShell on Windows because "export" is not what a Windows user's shell
 * accepts, and handing them a POSIX line is handing them an error they will read
 * as NASO being broken.
 */
function scopeCommand(prefix) {
  return process.platform === 'win32'
    ? `$env:NASO_SCOPE="${prefix}"; $env:NASO_SCOPE_STRICT="1"`
    : `export NASO_SCOPE="${prefix}" NASO_SCOPE_STRICT=1`;
}

/**
 * The area, or the deepest single area a prefix lands in.
 *
 * `guide src/components/Button` is a legitimate thing to ask and the answer is
 * `src/components/`. Mapping a prefix back to the area that owns it is what makes
 * a typo (`src/compnents`) an error instead of a silently empty screen.
 */
function resolveArea(facts, files, wanted) {
  const areas = facts.areas;
  const needle = String(wanted).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  const exact = areas.find((entry) => entry.name === needle);
  if (exact) return { area: exact, prefix: `${exact.name}/`, how: 'exact' };

  const under = areas.filter(
    (entry) => needle === entry.name || needle.startsWith(`${entry.name}/`),
  );
  if (under.length === 1) return { area: under[0], prefix: `${under[0].name}/`, how: 'area' };

  const owner = areas.find((entry) => needle.startsWith(`${entry.name}/`));
  if (owner) return { area: owner, prefix: `${owner.name}/`, how: 'area' };

  const matched = files.filter((file) => file === needle || file.startsWith(`${needle}/`));
  if (matched.length > 0) {
    const [head, ...rest] = needle.split('/').filter(Boolean);
    return {
      area: areas.find((entry) => entry.name === head) ?? null,
      prefix: rest.length > 0 ? `${needle}/` : `${head}/`,
      how: 'prefix',
      matched,
    };
  }

  return null;
}

/** Validation commands that plausibly cover one area, in the order to run them. */
function validationFor(facts, area) {
  const all = facts.validation ?? [];
  if (all.length === 0) return [];
  const areaWord = area.name.toLowerCase();
  const specific = all.filter((rule) => rule.command.toLowerCase().includes(areaWord));
  return specific.length > 0 ? specific : all;
}

/** The lines that are easy to cross inside one area, derived, not invented. */
function boundariesFor(facts, area, files) {
  const out = [];
  const dirs = [
    ...new Set(
      files
        .filter((file) => file.startsWith(`${area.name}/`))
        .map((file) => file.split('/').slice(0, 3).join('/')),
    ),
  ]
    .filter((dir) => dir.split('/').length <= 3 && dir !== area.name)
    .sort()
    .slice(0, 6);

  for (const dir of dirs) out.push(`\`${dir}/\` is inside this area — changes here are not a separate task.`);

  const subpackages = files.filter((file) => file.startsWith(`${area.name}/`) && /package\.json$/.test(file));
  if (subpackages.length > 0) {
    out.push(`Nested \`package.json\` at ${subpackages.length} path(s): treat those as their own packages.`);
  }

  const tests = area.testFiles ?? 0;
  if (area.files.length > 0 && tests === 0) {
    out.push(`No test files under \`${area.name}/\`. A change here has no gate but review.`);
  }

  if (area.entryPoint) out.push(`Entry point: \`${area.entryPoint}\`. Start reading here, not at the root index.`);

  const imports = (facts.conventions?.aliases ?? []).filter(
    ([from]) => from.startsWith(area.name) || from.startsWith(`${area.name}/`),
  );
  for (const [from, to] of imports.slice(0, 4)) {
    out.push(`\`${from}\` is an alias for \`${to}\` — resolve it before grepping for a real directory.`);
  }

  if (out.length === 0) {
    out.push('Nothing mechanical to flag: this area has no nested packages, aliases or test-free subtrees.');
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO guide

Usage:
  npx naso-dev guide <area-or-prefix> [target-dir]   everything about one area
  npx naso-dev guide --tour [target-dir]              walk the whole briefing
  npx naso-dev guide --list [target-dir]              the areas that exist

  --list    print the areas and stop

Writes nothing.

Exit codes: 0 fine, 1 the area is unknown or the briefing is out of date.
Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const tour = flags.has('tour');
  const listOnly = flags.has('list');

  // `guide src` and `guide src /repos/app` and `guide /repos/app src` all have to
  // work, because every other command takes a target dir while this one takes an
  // area. The rule: a positional that looks like a directory (`.`, `..`, absolute,
  // or containing a separator) is the target; a bare word is the area. With both
  // given, either order resolves.
  const looksLikeDir = (p) =>
    p === '.' || p === '..' || path.isAbsolute(p) || p.includes('/') || p.includes('\\');

  let target = null;
  let wanted = null;
  for (const token of positional) {
    if (target === null && looksLikeDir(token)) target = token;
    else if (wanted === null) wanted = token;
    else if (target === null) target = token;
  }
  if (tour || listOnly) wanted = null;

  const cwd = path.resolve(target ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev guide: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const version = await toolVersion();
  console.log(`# NASO Guide ${version} — ${cwd}`);
  console.log('');

  const agentsPath = path.join(cwd, 'AGENTS.md');
  if (!(await pathExists(agentsPath))) {
    console.log('No AGENTS.md here yet.');
    console.log('');
    console.log('Run setup to generate one from this repository:');
    console.log(`  npx naso-dev setup ${cwd}`);
    console.log('');
    return;
  }

  const briefing = await readFile(agentsPath, 'utf8');
  const facts = await scanRepo(cwd);

  const stamped = readBriefingMarkerValue(briefing, 'version');
  console.log(
    `AGENTS.md: ${plural(briefing.split('\n').length, 'line')}, generated by NASO ${stamped ?? 'an unknown version'}`,
  );
  if (stamped && compareVersions(stamped, version) !== 0) {
    const newer = compareVersions(stamped, version) > 0;
    console.log(
      newer
        ? `AGENTS.md was written by a newer NASO (${stamped}); this tool is ${version}. Update naso-dev rather than downgrading the briefing.`
        : `The tool is ${version}. Run \`npx naso-dev briefing ${cwd} refresh\` to move the stamp.`,
    );
  }
  console.log('');

  if (listOnly) {
    printAreaList(facts, briefing);
    return;
  }

  if (wanted) {
    const ok = await printArea(cwd, facts, briefing, wanted);
    if (!ok) process.exitCode = 1;
    return;
  }

  await printTour(cwd, facts, briefing);
}

// ---------------------------------------------------------------------------

function printAreaList(facts, briefing) {
  console.log(`## Areas in this repository (${facts.areas.length})`);
  console.log('');
  if (facts.areas.length === 0) {
    console.log('  None. There are no top-level directories to describe.');
    console.log('');
    return;
  }
  for (const entry of facts.areas) {
    const covered = briefing.includes(`${entry.name}/`);
    console.log(`  ${entry.name}/  ${String(entry.files.length).padStart(5)} files  ${describeEntry(entry).split('—')[1]?.trim() ?? ''}`);
    if (!covered) console.log(`           not mentioned in AGENTS.md yet`);
  }
  console.log('');
  console.log('  Read one:  npx naso-dev guide src .');
  console.log('');
}

async function printArea(cwd, facts, briefing, wanted) {
  const files = await listRepoFiles(cwd);
  const resolved = resolveArea(facts, files, wanted);

  if (!resolved) {
    console.log(`No area or path here matches \`${wanted}\`.`);
    console.log('');
    const known = facts.areas.map((entry) => `  ${entry.name}/  ${plural(entry.files.length, 'file')}`);
    console.log(known.length > 0 ? 'These do exist:' : 'This repository has no top-level areas at all.');
    for (const line of known) console.log(line);
    console.log('');
    console.log('  List them again:  npx naso-dev guide --list .');
    console.log('  Everything NASO could not name:');
    const unknown = facts.areas.filter((entry) => !entry.role);
    for (const entry of unknown) console.log(`    ${entry.name}/`);
    console.log('');
    process.exitCode = 1;
    return false;
  }

  const { area, prefix, how } = resolved;
  const areaFiles = files.filter((file) => file.startsWith(prefix));
  const scopePrefix = prefix;

  console.log(`## ${area ? `${area.name}/` : prefix} — ${area ? humanize(area.name) : 'path'}`);
  console.log('');

  if (how === 'prefix' && area && prefix !== `${area.name}/`) {
    console.log(`  Asked for \`${wanted}\`; that is a path inside \`${area.name}/\`, so this is the area that owns it.`);
    console.log('');
  }

  if (area) {
    console.log(`  ${describeEntry(area)}`);
  } else {
    console.log(`  Not a top-level area, so NASO has no name or role for it — only the file count.`);
  }
  console.log('');
  console.log(`  Tracked and untracked-but-not-ignored files under ${prefix}: ${areaFiles.length}`);
  if (areaFiles.length > 0) {
    const languages = new Map();
    for (const file of areaFiles) {
      const ext = path.extname(file).slice(1).toLowerCase() || 'no extension';
      languages.set(ext, (languages.get(ext) ?? 0) + 1);
    }
    const mix = Array.from(languages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext} ×${count}`);
    console.log(`  By extension: ${mix.join(', ')}`);
    const shown = areaFiles.slice(0, 8);
    for (const file of shown) console.log(`    ${file}`);
    if (areaFiles.length > shown.length) {
      console.log(`    … and ${areaFiles.length - shown.length} more`);
    }
  }
  console.log('');

  const covered = briefing.includes(prefix);
  console.log('## In the briefing');
  console.log('');
  console.log(
    covered
      ? `  Yes — AGENTS.md names \`${prefix}\`.`
      : `  No — AGENTS.md does not mention \`${prefix}\`. The pre-commit hook appends a line for a genuinely new area;`,
  );
  if (!covered) {
    console.log('  to have it described properly now, re-run setup with --force.');
    console.log('  To hide it on purpose instead, re-run setup and exclude it.');
  }
  console.log('');

  const rules = validationFor(facts, area ?? { name: prefix.replace(/\/$/, '') });
  console.log('## What has to pass');
  console.log('');
  if (rules.length === 0) {
    console.log('  Nothing detected. No lint, typecheck, test or build script is declared in package.json,');
    console.log('  so there is no command for the hook to run and none for you to claim you ran.');
  } else {
    if (rules.length === facts.validation.length && facts.validation.length > 1) {
      console.log('  No command names this area, so these are the repository-wide ones that cover it:');
      console.log('');
    }
    for (const rule of rules) {
      console.log(`  $ ${rule.command}`);
      if (rule.why) console.log(`      ${rule.why}`);
    }
  }
  console.log('');

  console.log('## Boundaries worth knowing before you edit');
  console.log('');
  for (const line of boundariesFor(facts, area ?? { name: prefix.replace(/\/$/, ''), files: areaFiles, testFiles: 0 }, areaFiles)) {
    for (const wrapped of wrapText(line, 74)) console.log(`  ${wrapped}`);
  }
  console.log('');

  console.log('## Claim the scope, then work');
  console.log('');
  console.log('  Paste this before you edit, so the pre-commit hook tells you when you wander:');
  console.log('');
  console.log(`    ${scopeCommand(scopePrefix)}`);
  console.log('');
  console.log('  A task that legitimately spans areas: claim both, comma-separated.');
  console.log('  Nothing is enforced until NASO_SCOPE_STRICT=1 is set, which the line above does.');
  console.log('');

  console.log('## Read the code, not just the file list');
  console.log('');
  console.log('  AGENTS.md says what this area is for. It does not say what the code does.');
  console.log('  For the orientation, walk the whole briefing:  npx naso-dev guide --tour .');
  console.log('');

  const check = await checkBriefing(cwd);
  if (!check.ok) {
    console.log(`AGENTS.md has ${check.problems.length} problem(s) against the repository:`);
    for (const problem of check.problems) console.log(`  ${problem.kind}  ${problem.item}`);
    console.log('');
  }
  return check.ok;
}

async function printTour(cwd, facts, briefing) {
  const check = await checkBriefing(cwd);
  if (check.ok) {
    console.log(
      `Consistent: ${check.tokens.length} path claim(s) verified, ` +
        `${check.entries.length} top-level area(s) covered.`,
    );
  } else {
    console.log(`${check.problems.length} problem(s) against the repository:`);
    for (const problem of check.problems) console.log(`  ${problem.kind}  ${problem.item}`);
  }
  console.log('');

  if (!process.argv.includes('--short')) printWalkthrough(briefing);

  const unknown = facts.areas.filter((entry) => !entry.role);
  console.log('## What NASO could not work out');
  console.log('');
  if (unknown.length === 0) {
    console.log('  Nothing. Every area was named by its own name or by a manifest at its root.');
  } else {
    console.log('  These areas have a name NASO does not recognize and no manifest, so their');
    console.log('  line says so rather than guessing. Only you know what they are:');
    console.log('');
    for (const entry of unknown) {
      console.log(`  - \`${entry.name}/\` — ${plural(entry.files.length, 'file')}. Replace that line in AGENTS.md with the real one.`);
    }
  }
  console.log('');

  await printNextSteps(cwd, facts, unknown);

  if (!check.ok) process.exitCode = 1;
}

function wrapText(text, width) {
  return text.match(new RegExp(`.{1,${width}}(\\s|$)`, 'g'))?.map((s) => s.trim()) ?? [text];
}

async function printNextSteps(cwd, facts, unknown) {
  const steps = [];

  if (facts.validation.length > 0) {
    steps.push({
      title: 'Run the full gate once, before you trust it',
      body:
        'The pre-commit hook only checks staged files. A full run type-checks and tests ' +
        'everything, which is what CI will do.',
      command: `npx naso-dev validate ${cwd}`,
    });
  }

  const scopeCandidates = facts.areas
    .filter((entry) => entry.testFiles === 0 && ['src', 'lib', 'app', 'apps', 'packages'].includes(entry.name))
    .map((entry) => entry.name);
  if (scopeCandidates.length > 0) {
    steps.push({
      title: 'Decide whether you want the scope check',
      body:
        `Export the prefixes a task owns before editing, and the hook reports anything staged ` +
        `outside them. ${scopeCandidates.length === 1 ? 'This repository has one obvious candidate' : 'This repository has candidates'}: ` +
        `${scopeCandidates.join(', ')}. Without it the check stays off rather than guessing.`,
      command: scopeCommand(`${scopeCandidates[0]}/`),
    });
  }

  const ignored = await run('git', ['check-ignore', '-q', 'AGENTS.md'], { cwd });
  if (ignored.code === 0) {
    steps.push({
      title: 'Decide whether to commit the briefing',
      body:
        'AGENTS.md is excluded locally, so only this machine has it. That is right for a ' +
        'repository you do not own. For one you do, commit it so the next agent on any ' +
        'machine gets it too.',
      command: `npx naso-dev setup ${cwd} --track`,
    });
  }

  steps.push({
    title: 'Keep it true',
    body:
      'Nobody regenerates this file. When a commit adds an area, the hook appends one line ' +
      'for it and, if the file is tracked and clean, stages it with that commit. Everything ' +
      'else is ordinary code review.',
    command: `npx naso-dev briefing ${cwd}`,
  });

  console.log('## Next steps');
  console.log('');
  steps.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step.title}`);
    for (const line of wrapText(step.body, 72)) console.log(`     ${line}`);
    if (step.command) console.log(`     $ ${step.command}`);
    console.log('');
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev guide: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
