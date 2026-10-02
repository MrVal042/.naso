#!/usr/bin/env node
// NASO Guide — read the briefing back against the code and say what to do next.
//
// `briefing` answers "is the briefing true?". `guide` answers "what do I do with
// it?", which is the question a briefing cannot answer about itself: it is the
// thing being described, so it has no room to describe how to read it.
//
// Three parts:
//
//   1. A walkthrough of the briefing, section by section, in the order an agent
//      should read it — so a person who has just inherited a repository learns
//      the same orientation the agent gets.
//   2. Drift: the same check the pre-commit hook enforces, run on demand.
//   3. Next steps chosen from what this repository actually looks like — the
//      validation commands that exist, the areas NASO could not name, the scope
//      prefixes worth exporting.
//
// Nothing is written. A guide that edited what it was describing would be a worse
// guide than no guide.
//
// Usage:
//   node tooling/guide.mjs [target-dir] [--short]
//
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pathExists,
  parseArgs,
  run,
  toolVersion,
  isMainModule,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { scanRepo, checkBriefing, readBriefingMarkerValue } from './briefing.mjs';

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
      console.log(`      ${bullets} line${bullets === 1 ? '' : 's'} of specifics`);
    }
    console.log('');
  }

  if (sections.length === 0) {
    console.log('  The briefing has no sections yet.');
    console.log('');
  }
}

async function printNextSteps(cwd, facts, unknown) {
  const steps = [];

  if (facts.validation.length > 0) {
    steps.push({
      title: 'Run the full gate once, before you trust it',
      body:
        'The pre-commit hook only checks staged files. A full run type-checks and tests ' +
        'everything, which is what CI will do.',
      command: `npx naso validate ${cwd}`,
    });
  }

  const scopeCandidates = facts.entries
    .filter((entry) => entry.isDir && entry.testFiles === 0 && ['src', 'lib', 'app', 'apps', 'packages'].includes(entry.name))
    .map((entry) => entry.name);
  if (scopeCandidates.length > 0) {
    steps.push({
      title: 'Decide whether you want the scope check',
      body:
        `Export the prefixes a task owns before editing, and the hook reports anything staged ` +
        `outside them. ${scopeCandidates.length === 1 ? 'This repository has one obvious candidate' : 'This repository has candidates'}: ` +
        `${scopeCandidates.join(', ')}. Without it the check stays off rather than guessing.`,
      command: `export NASO_SCOPE=${scopeCandidates[0]}`,
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
      command: `npx naso setup ${cwd} --track`,
    });
  }

  steps.push({
    title: 'Keep it true',
    body:
      'Nobody regenerates this file. When a commit adds an area, the hook appends one line ' +
      'for it and, if the file is tracked and clean, stages it with that commit. Everything ' +
      'else is ordinary code review.',
    command: `npx naso briefing ${cwd}`,
  });

  console.log('## Next steps');
  console.log('');
  steps.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step.title}`);
    for (const line of step.body.match(/.{1,72}(\s|$)/g) ?? [step.body]) {
      console.log(`     ${line.trim()}`);
    }
    if (step.command) console.log(`     $ ${step.command}`);
    console.log('');
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO guide

Usage:
  node tooling/guide.mjs [target-dir] [--short]

  --short   print the check result and next steps, skip the walkthrough

Writes nothing.

Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso guide: target directory does not exist: ${cwd}`);
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
    console.log(`  npx naso setup ${cwd}`);
    console.log('');
    return;
  }

  const briefing = await readFile(agentsPath, 'utf8');
  const facts = await scanRepo(cwd);

  // An area is "named" if its directory name is one NASO recognizes or if it has
  // a manifest at its root. briefing.mjs resolves both into entry.role.
  const unknown = facts.entries.filter((entry) => entry.isDir && !entry.role);

  const stamped = readBriefingMarkerValue(briefing, 'version');
  console.log(`AGENTS.md: ${briefing.split('\n').length} lines, generated by naso ${stamped ?? 'an unknown version'}`);
  if (stamped && stamped !== version) {
    console.log(`The tool is ${version}. Run \`npx naso briefing ${cwd} refresh\` to move the stamp.`);
  }
  console.log('');

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

  if (!flags.has('short')) printWalkthrough(briefing);

  console.log('## What NASO could not work out');
  console.log('');
  if (unknown.length === 0) {
    console.log('  Nothing. Every area was named by its own name or by a manifest at its root.');
  } else {
    console.log('  These areas have a name NASO does not recognize and no manifest, so their');
    console.log('  line says so rather than guessing. Only you know what they are:');
    console.log('');
    for (const entry of unknown) {
      console.log(`  - \`${entry.name}/\` — ${entry.files.length} files. Replace that line in AGENTS.md with the real one.`);
    }
  }
  console.log('');

  await printNextSteps(cwd, facts, unknown);

  if (!check.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso guide: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
