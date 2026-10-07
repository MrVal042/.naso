#!/usr/bin/env node
// NASO flow — what `npx naso-dev` does with no command.
//
// One command, in the order the work actually happens: read the repository, say
// what was found, say what will be written, ask, and only then write. The two
// commands this replaces did the same two halves in two invocations, which meant
// the explanation and the decision were separated by a shell prompt and a copy-
// paste, and a person who pasted the second command without reading the first got
// a repository rewritten on the strength of output they had not seen.
//
// Three properties this file exists to hold:
//
//   Nothing is written before the answer. Not a staging area, not a config file,
//   not a half-written AGENTS.md. The pre-commit hook is installed last, after
//   the briefing is on disk, so an interrupted run leaves a briefing and no hook
//   rather than a hook that fails on a file that is not there.
//
//   A run that cannot be answered stops instead of waiting. No TTY, no prompt,
//   no --yes, nothing written and exit 0 — because the useful thing to print for
//   a pipe or a CI step is the plan, and the useful thing to do is nothing.
//
//   The flow is a path through the same code the retired commands run. It calls
//   inspect() and install() rather than reimplementing them, so `npx naso-dev`
//   and `npx naso-dev setup --yes` cannot drift into producing two different
//   AGENTS.md files.
//
// Not vendored: this module imports a prompt library and picocolors, and the
// vendored toolset has to run with no node_modules anywhere near it. See
// vendorSources().

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathExists, parseArgs, listOption, run, toolVersion, nasoDir, isInteractive } from './lib.mjs';
import { topLevelEntries, areasOf, dominantLanguage, splitNul, NASO_START, NASO_END } from './briefing.mjs';
import { describeHook } from './install.mjs';
import { NASO_DIR, isVendored, vendoredVersion } from './vendor.mjs';
import { inspect, install, displayPlan, HOOK_ACTIONS } from './setup.mjs';
import { colorEnabled, createStyle } from './ui.mjs';
import { confirm, select, isCancel, note, outro } from '@clack/prompts';

const AGENTS_FILE = 'AGENTS.md';

/**
 * The whole pitch, in five lines.
 *
 * The long version this replaces was forty lines of rationale printed before
 * anybody had seen a single fact about their repository, which is backwards: the
 * argument for a tool is only interesting next to what the tool found. The long
 * form is still there, behind --why, for the person who wants it.
 */
function explain(style, { why }) {
  const lines = [
    `${style.bold('What this does')}  reads this repository, writes an AGENTS.md briefing`,
    '                    that says what every area is for and what must pass before',
    `                    work counts as done, then copies a small toolset into ${style.path(NASO_DIR)}/`,
    '                    and installs a pre-commit gate to keep the briefing true.',
    '',
    `${style.bold('Before you accept')}  nothing at all is written. Answering no leaves this`,
    '                    repository exactly as it is, and that is a valid outcome.',
  ];

  if (why) {
    lines.push(
      '',
      `${style.bold('Why it is worth it')}`,
      '',
      'An AI coding agent starts every session knowing nothing about your',
      'repository. Without a briefing it explores blind, guesses at architecture,',
      'and confidently invents files that were never there — and because the answer',
      'sounds authoritative, it is believed. That costs more time than the briefing',
      'takes to write, and it recurs on every task.',
      '',
      'The briefing starts out true rather than aspirational, because it is generated',
      'from what is actually on disk, and the pre-commit gate keeps it true by',
      'refusing commits that leak a secret or drift outside the claimed scope.',
    );
  }

  return lines;
}

/** This repository, as far as the flow needs to know before it asks anything. */
async function describeRepository(cwd) {
  const isRepo = (await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })).ok;
  if (!isRepo) return { isRepo: false };

  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  // -z and split on NUL: a repository with a non-ASCII filename is not an exotic one,
  // and `"\303\251.env"` is not a path anybody can paste into a command.
  const filesRes = await run('git', ['ls-files', '-z'], { cwd });
  const files = filesRes.ok ? splitNul(filesRes.stdout) : [];
  const entries = topLevelEntries(files);

  return {
    isRepo: true,
    branch: branchRes.ok ? branchRes.stdout.trim() : null,
    files: files.length,
    areas: areasOf(entries).map((entry) => entry.name),
    language: dominantLanguage(files),
  };
}

/**
 * What is already here, and which of it is NASO's.
 *
 * Only NASO's own state makes a repository "already set up": a NASO block in AGENTS.md,
 * the vendored toolset, or NASO's hook. A hand-written AGENTS.md and somebody else's
 * pre-commit hook are facts about the repository the plan has to respect, not evidence
 * that setup ran — treating them as such left every husky or lefthook repository with no
 * way to be set up at all.
 */
async function describeCurrentState(cwd) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  const hasBriefing = await pathExists(agentsPath);

  let stampedVersion = null;
  let hasBlock = false;
  if (hasBriefing) {
    const content = await readFile(agentsPath, 'utf8').catch(() => '');
    stampedVersion = content.match(/^<!--\s*version:\s*(.+?)\s*-->$/m)?.[1] ?? null;
    hasBlock = content.includes(NASO_START) && content.includes(NASO_END);
  }

  const hook = await describeHook(cwd);
  const vendored = await isVendored(cwd);

  return {
    hasBriefing,
    hasBlock,
    stampedVersion,
    vendored,
    vendoredVersion: await vendoredVersion(cwd),
    hook,
    setUp: hasBlock || vendored || hook.state === 'naso',
  };
}

function reportExistingState(state, cwd, style) {
  const lines = ['', style.heading('Already set up'), ''];

  if (state.hasBlock) {
    lines.push(
      style.bullet(
        `${AGENTS_FILE} carries a NASO block${state.stampedVersion ? `, generated by NASO ${state.stampedVersion}` : ''}.`,
      ),
      `    ${style.dim('Check it still matches the code:')} npx naso-dev briefing ${cwd}`,
      `    ${style.dim('Read the guide for one area:')}   npx naso-dev guide ${cwd} <area>`,
    );
  }
  if (state.vendored) {
    lines.push(
      style.bullet(`The toolset is vendored at ${NASO_DIR}/tooling${state.vendoredVersion ? `, from ${state.vendoredVersion}` : ''}.`),
      `    ${style.dim('Bring it up to date:')}           npx naso-dev refresh ${cwd}`,
    );
  }
  if (state.hook.state === 'naso') {
    lines.push(style.bullet(`The pre-commit hook is installed at ${state.hook.path}.`));
  } else if (state.hook.state === 'foreign') {
    lines.push(style.warn(`${state.hook.path} exists and was not written by NASO; it is left alone.`));
  }

  lines.push(
    '',
    'To regenerate the NASO block and re-run setup from what is on disk now:',
    `  ${style.flag('npx naso-dev')} ${cwd} ${style.flag('--force')}`,
    '',
  );

  return lines;
}

/**
 * Ask what the plan depends on, and nothing it does not.
 *
 * Each question has a conservative default — keep the files out of git, leave a hook
 * NASO did not write alone, rewrite nothing — so a run of Enters produces the least
 * invasive install that still works. A question whose answer cannot change the plan is
 * not asked: the hook question only appears when there is a choice to make, and the
 * block question only when there is a block.
 */
async function ask(style, options, context) {
  note('Answer with Enter to accept the default. Nothing is written until the last question.', {
    title: style.bold('Questions'),
  });

  const track = await confirm({
    message: 'Commit AGENTS.md and .naso/ to git? (No keeps them local to this machine.)',
    initialValue: options.track,
  });
  if (isCancel(track)) return null;

  let noHook = options.noHook;
  let hookAction = options.hookAction;
  const { hook } = context;
  if (!noHook && !hookAction && hook.state === 'foreign') {
    const choice = await select({
      message: `Hook: existing hook at ${hook.path}, not written by NASO. What should happen to it?`,
      initialValue: 'skip',
      options: [
        { value: 'chain', label: 'Chain', hint: 'move it aside unchanged; NASO\'s hook runs it first' },
        { value: 'skip', label: 'Skip', hint: 'leave it exactly as it is; no NASO hook' },
        { value: 'abort', label: 'Abort', hint: 'write nothing at all' },
      ],
    });
    if (isCancel(choice)) return null;
    hookAction = choice;
  } else if (!noHook && !hookAction && hook.trackedDir) {
    const choice = await select({
      message: `core.hooksPath is ${hook.hooksPath}, which git tracks. Write the pre-commit hook there?`,
      initialValue: 'skip',
      options: [
        { value: 'install', label: 'Install there', hint: 'the hook becomes a file in your next commit' },
        { value: 'skip', label: 'Skip', hint: 'no NASO hook; run the gate by hand' },
        { value: 'abort', label: 'Abort', hint: 'write nothing at all' },
      ],
    });
    if (isCancel(choice)) return null;
    hookAction = choice;
  } else if (!noHook && hook.state !== 'not-repo') {
    const install = await confirm({ message: 'Install the pre-commit gate?', initialValue: true });
    if (isCancel(install)) return null;
    noHook = !install;
  }

  let force = options.force;
  if (!force && context.hasBlock) {
    const replace = await confirm({
      message: 'AGENTS.md already has a NASO block. Replace it with one generated from the repository as it is now?',
      initialValue: false,
    });
    if (isCancel(replace)) return null;
    force = replace;
  }

  return { track, noHook, force, hookAction };
}

/**
 * `ask` is an argument so the flow can be driven without a terminal.
 *
 * A pty is the only honest way to test a prompt, and a pty in CI is a flaky
 * dependency and a way to hang a test suite forever when it goes wrong. So the
 * question layer is injected: the flow's own logic — what it does with an
 * answer, and what it does with a cancellation — is tested directly, and what is
 * *not* tested is @clack's rendering, which is a library's job and not ours.
 *
 * @param {object} [deps]
 * @param {(style: object, options: object) => Promise<object|null>} [deps.ask]
 * @param {() => boolean} [deps.interactive]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const askQuestions = deps.ask ?? ask;
  const { flags, values, lists, positional } = parseArgs(argv);
  const style = createStyle(colorEnabled(flags));

  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO

Usage:
  npx naso-dev [target-dir] [options]

One command, in the order it happens: read this repository, show what was
found, show what will be written, ask, then write. Nothing is written before
the answer.

Options:
  --track            commit ${NASO_DIR}/ and ${AGENTS_FILE} instead of excluding them locally
  --no-hook          do not install the pre-commit gate
  --exclude <prefix> keep an area out of the briefing; repeatable, saved to config.json
  --force            replace an existing naso:start / naso:end block, and nothing else
  --hook-action <a>  install | chain | skip | abort, for a hook NASO did not write
                     or a core.hooksPath directory git tracks (default: skip)
  --yes              accept the plan without asking; for CI, scripts and agents
  --dry-run          print the plan and stop
  --why              the long-form rationale for doing this at all
  --no-color         no escape codes, whatever the terminal supports

With no terminal and no --yes, this prints the plan, writes nothing, and exits 0.

Other commands:
  briefing   regenerate or re-verify the ${AGENTS_FILE} briefing
  refresh    re-vendor the toolset and move the version stamp
  guide      guide for one area, or --tour for a read-through
  validate   the pre-commit gate, run by hand
  doctor     diagnose the environment and the install`);
    return;
  }

  const cwd = path.resolve(positional[0] ?? process.cwd());
  const options = {
    track: flags.has('track'),
    noHook: flags.has('no-hook'),
    force: flags.has('force'),
    yes: flags.has('yes'),
    dryRun: flags.has('dry-run'),
    exclude: listOption(lists, 'exclude'),
    hookAction: values.get('hook-action') ?? null,
  };

  if (options.hookAction !== null && !HOOK_ACTIONS.includes(options.hookAction)) {
    console.error(`naso-dev: --hook-action must be one of ${HOOK_ACTIONS.join(', ')}; got '${options.hookAction}'.`);
    process.exitCode = 1;
    return;
  }

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const version = await toolVersion();
  const gitVersion = await run('git', ['--version']);
  const repo = await describeRepository(cwd);
  const state = await describeCurrentState(cwd);

  console.log('');
  console.log(`${style.bold(`NASO ${version}`)}  ${style.dim(cwd)}`);
  console.log(
    `${style.dim(`${process.version} · ${gitVersion.ok ? gitVersion.stdout.trim() : 'git not found'}`)}`,
  );
  console.log('');

  console.log(style.heading('This repository'));
  console.log('');
  if (!repo.isRepo) {
    console.log(
      'Not a git repository. NASO still works on one, but the pre-commit gate and the',
      'scope check both need git, and the briefing would have nothing to check itself',
      'against.',
    );
  } else {
    console.log(
      `${style.dim('Branch')}    ${repo.branch ?? 'unknown'}\n` +
        `${style.dim('Files')}     ${repo.files} tracked in the git index\n` +
        `${style.dim('Areas')}     ${repo.areas.length} top-level ${repo.areas.length === 1 ? 'directory' : 'directories'}` +
        `${repo.areas.length ? ` (${repo.areas.slice(0, 8).join(', ')}${repo.areas.length > 8 ? ', …' : ''})` : ''}` +
        (repo.language ? `\n${style.dim('Language')}  ${repo.language.label}, ${repo.language.count} of ${repo.files} files` : ''),
    );
  }
  console.log('');

  const interactive = deps.interactive ?? isInteractive();

  // A repository NASO already set up is reported, not re-planned — unless --force asks
  // for the block to be regenerated, or a person at a terminal can be asked whether to.
  if (state.setUp && !options.force && (options.yes || options.dryRun || !interactive)) {
    for (const line of reportExistingState(state, cwd, style)) console.log(line);
    return;
  }

  for (const line of explain(style, { why: flags.has('why') })) console.log(line);
  console.log('');

  let choices = options;

  if (options.dryRun) {
    const plan = await inspect(cwd, options);
    await displayPlan(plan, cwd, style);
    console.log(`${style.dim('--dry-run: nothing was written.')}`);
    return;
  }

  if (!options.yes && interactive) {
    const answered = await askQuestions(style, options, { hook: state.hook, hasBlock: state.hasBlock });
    if (answered === null) {
      outro(style.warn('Cancelled. Nothing was written.'));
      return;
    }
    choices = { ...options, ...answered };
  }

  const plan = await inspect(cwd, choices);
  await displayPlan(plan, cwd, style);

  if (plan.hookDecision.action === 'abort') {
    console.log(style.heading('Aborted'));
    console.log('');
    console.log('You chose to abort at the hook. Nothing was written.');
    console.log('');
    return;
  }

  if (!options.yes && !interactive) {
    console.log(style.heading('Not written'));
    console.log('');
    console.log('This terminal cannot answer a question, so nothing was written — which');
    console.log('makes this command safe to run from a script, a CI step or an agent.');
    console.log('');
    console.log(`Read the plan above, then re-run with ${style.flag('--yes')} to accept it:`);
    console.log(`  ${style.flag('npx naso-dev')} ${style.flag('--yes')} ${cwd}`);
    console.log('');
    return;
  }

  const label = options.yes ? '--yes: accepting the plan above.' : 'Accepted.';
  console.log(`${style.dim(label)}`);
  console.log('');

  const ok = await install(cwd, { ...choices, state: plan });
  if (!ok) process.exitCode = 1;
}