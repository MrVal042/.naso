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
//   no --yes: the plan is printed, nothing is written, and the exit code is 2, so a
//   script can tell "not done" from "done". --dry-run is the way to ask for only the
//   plan, and it exits 0.
//
//   The flow is a path through the same code the retired commands run. It calls
//   inspect() and install() rather than reimplementing them, so `npx naso-dev`
//   and `npx naso-dev setup --yes` cannot drift into producing two different
//   AGENTS.md files.
//
// Not vendored: it is the interactive setup, and the pre-commit hook never asks
// anything. See vendorSources().

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathExists, parseArgs, listOption, run, toolVersion, isInteractive, supportTemplate, readJSONFile, detectPackageManager, SUPPORT_EMAIL, nasoCommand } from './lib.mjs';
import { topLevelEntries, areasOf, dominantLanguage, splitNul, NASO_START, NASO_END } from './briefing.mjs';
import { describeHook } from './install.mjs';
import { detectStack } from './stack.mjs';
import { parseIgnorePatterns } from './scan.mjs';
import { NASO_DIR, isVendored, vendoredVersion } from './vendor.mjs';
import { inspect, install, displayPlan, displayOverview, devDependencyPlan, HOOK_ACTIONS } from './setup.mjs';
import { colorEnabled, createStyle } from './ui.mjs';
import { confirm, select, isCancel, note, outro } from './prompt.mjs';

const AGENTS_FILE = 'AGENTS.md';

/**
 * The column every labelled value on the opening screen starts in.
 *
 * One width for the explanation and the repository facts alike, taken from the longest
 * label, so the two blocks read as one table instead of two differently indented lists.
 */
const LABELS = ['What this does', 'Before you accept', 'Branch', 'Files', 'Areas', 'Language'];
const LABEL_WIDTH = Math.max(...LABELS.map((label) => label.length)) + 2;

/** A label padded to LABEL_WIDTH, then the first line; later lines indented to match. */
function labelled(paint, label, lines) {
  const [first, ...rest] = lines;
  return [
    `${paint(label)}${' '.repeat(LABEL_WIDTH - label.length)}${first}`,
    ...rest.map((line) => `${' '.repeat(LABEL_WIDTH)}${line}`),
  ];
}

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
    ...labelled(style.bold, 'What this does', [
      'reads this repository, writes an AGENTS.md briefing',
      'that says what every area is for and what must pass before',
      `work counts as done, then copies a small toolset into ${style.path(NASO_DIR)}/`,
      'and installs a pre-commit gate to keep the briefing true.',
    ]),
    '',
    ...labelled(style.bold, 'Before you accept', [
      'nothing at all is written. Answering no leaves this',
      'repository exactly as it is, and that is a valid outcome.',
    ]),
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
    stack: (
      await detectStack(cwd, files, {
        ignore: parseIgnorePatterns(await readFile(path.join(cwd, '.gitignore'), 'utf8').catch(() => '')).all,
      })
    ).short,
  };
}

/**
 * What is already here, and which of it is NASO's.
 *
 * Only NASO's own state makes a repository "already set up": a NASO block in AGENTS.md
 * or the vendored toolset. A hand-written AGENTS.md and somebody else's
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
    // NASO's hook on its own is the remains of a partial install, not an install: the
    // plan reinstalls it along with everything that is missing.
    setUp: hasBlock || vendored,
  };
}

function reportExistingState(state, cwd, style) {
  const lines = ['', style.heading('Already set up'), ''];

  if (state.hasBlock) {
    lines.push(
      style.bullet(
        `${AGENTS_FILE} carries a NASO block${state.stampedVersion ? `, generated by NASO ${state.stampedVersion}` : ''}.`,
      ),
      `    ${style.dim('Check it still matches the code:')} ${nasoCommand()} briefing ${cwd}`,
      `    ${style.dim('Read the guide for one area:')}   ${nasoCommand()} guide ${cwd} <area>`,
    );
  }
  if (state.vendored) {
    lines.push(
      style.bullet(`The toolset is vendored at ${NASO_DIR}/tooling${state.vendoredVersion ? `, from ${state.vendoredVersion}` : ''}.`),
      `    ${style.dim('Bring it up to date:')}           ${nasoCommand()} refresh ${cwd}`,
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
    `  ${style.flag(nasoCommand())} ${cwd} ${style.flag('--force')}`,
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
async function ask(style, options, context, io = {}) {
  note('Answer with Enter to accept the default. Nothing is written until you accept the plan.', style.bold('Questions'), { style, ...io });

  const track = await confirm({
    message: 'Commit AGENTS.md and .naso/ to git? (No keeps them local to this machine.)',
    initialValue: options.track,
    style,
    ...io,
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
      style,
      ...io,
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
      style,
      ...io,
    });
    if (isCancel(choice)) return null;
    hookAction = choice;
  } else if (!noHook && hook.state !== 'not-repo') {
    const install = await confirm({ message: 'Install the pre-commit gate?', initialValue: true, style, ...io });
    if (isCancel(install)) return null;
    noHook = !install;
  }

  let force = options.force;
  if (!force && context.hasBlock) {
    const replace = await confirm({
      message: 'AGENTS.md already has a NASO block. Replace it with one generated from the repository as it is now?',
      initialValue: false,
      style,
      ...io,
    });
    if (isCancel(replace)) return null;
    force = replace;
  }

  // Asked last and only when there is something to record. "No" is the default nowhere
  // else in this flow either way: a person who ran `npx naso-dev` to set up a repository
  // wants it to stay set up for the next person, which is what the dev dependency does.
  let saveDev = options.saveDev;
  const dev = context.devDependency;
  if (!saveDev && dev && dev.action !== 'present') {
    const record = await confirm({
      message:
        dev.action === 'move'
          ? `naso-dev is in dependencies, where production installs pick it up. Move it to devDependencies with ${dev.pm}?`
          : `Add naso-dev to devDependencies with ${dev.pm}, so teammates get the same version?`,
      initialValue: true,
      style,
      ...io,
    });
    if (isCancel(record)) return null;
    saveDev = record;
  }

  return { track, noHook, force, hookAction, saveDev };
}

/**
 * The questions this flow asks, drawn with ./prompt.mjs.
 *
 * Every function resolves to an answer, or to null when the person cancelled (Ctrl+C or
 * Escape). `io` is the input and output streams, so the real prompts can be driven by a
 * test without a pty; in a terminal it is empty and the prompts use stdin and stdout.
 */
export function terminalPrompts(io = {}) {
  return {
    questions: (style, options, context) => ask(style, options, context, io),

    async decide(style, { rejections, installsHook }) {
      const choice = await select({
        message: installsHook ? 'Write these files and install the hook?' : 'Write these files? (No hook will be installed.)',
        initialValue: 'accept',
        options: [
          { value: 'accept', label: 'Accept', hint: 'write exactly the files listed above' },
          { value: 'details', label: 'Show details', hint: 'every file, what the briefing says, and why' },
          {
            value: 'reject',
            label: 'Reject',
            hint: rejections === 0 ? 'write nothing, read the repository again' : 'write nothing and stop',
          },
          { value: 'exclude', label: 'Exclude an area', hint: 'keep one out of the briefing, then show the plan again' },
        ],
        style,
        ...io,
      });
      return isCancel(choice) ? null : choice;
    },

    async pickArea(style, areas) {
      const choice = await select({
        message: 'Which area should the briefing leave out?',
        options: areas.map((area) => ({ value: area.name, label: `${area.name}/`, hint: `${area.files.length} files` })),
        style,
        ...io,
      });
      return isCancel(choice) ? null : choice;
    },

    async afterRejections(style) {
      const choice = await select({
        message: 'Rejected twice. How would you like to finish?',
        initialValue: 'exit',
        options: [
          { value: 'exit', label: 'Exit', hint: 'leave this repository exactly as it is' },
          { value: 'support', label: 'Contact support', hint: 'print a pre-filled report to send' },
        ],
        style,
        ...io,
      });
      return isCancel(choice) ? null : choice;
    },

    done(message) {
      outro(message, io);
    },
  };
}

/** `deps.interactive` is a boolean or a function returning one; absent, ask the terminal. */
function resolveInteractive(deps) {
  if (typeof deps.interactive === 'function') return Boolean(deps.interactive());
  if (typeof deps.interactive === 'boolean') return deps.interactive;
  return isInteractive();
}

/**
 * The flow, with its question layer injectable.
 *
 * `deps.prompts` replaces the terminal prompts (see `terminalPrompts`), so what the flow *does*
 * with an answer — and with a rejection, an exclusion, a cancellation — is tested without
 * a pty. The prompt adapter itself is tested by driving it through streams.
 *
 * @param {object} [deps]
 * @param {ReturnType<typeof terminalPrompts>} [deps.prompts]
 * @param {boolean | (() => boolean)} [deps.interactive]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const prompts = deps.prompts ?? terminalPrompts();
  const { flags, values, lists, positional } = parseArgs(argv);
  const style = createStyle(colorEnabled(flags));

  if (flags.has('help')) {
    console.log(`NASO

Usage:
  ${nasoCommand()} [target-dir] [options]

One command, in the order it happens: read this repository, show what was
found, ask what the plan depends on, list every file it would write, and ask
once more: accept, reject, or exclude an area. Nothing is written before you
accept. Rejecting reads the repository again; rejecting twice stops, with the
repository exactly as it was.

Options:
  --track            commit ${NASO_DIR}/ and ${AGENTS_FILE} instead of excluding them locally
  --no-hook          do not install the pre-commit gate
  --exclude <prefix> keep an area out of the briefing; repeatable, saved to config.json
  --force            replace an existing naso:start / naso:end block, and nothing else
  --hook-action <a>  install | chain | skip | abort, for a hook NASO did not write
                     or a core.hooksPath directory git tracks (default: skip)
  --save-dev         record naso-dev in devDependencies with this repository's
                     package manager (asked when there is a terminal)
  --yes              accept the plan without asking; for CI, scripts and agents
  --dry-run          print the plan and stop
  --why              the long-form rationale for doing this at all
  --no-color         no escape codes, whatever the terminal supports

With no terminal and no --yes, this prints the plan, writes nothing, and exits 2.
--dry-run prints the same plan and exits 0.

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
    saveDev: flags.has('save-dev'),
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
    console.log('Not a git repository. NASO still works on one, but the pre-commit gate and the');
    console.log('scope check both need git, and the briefing would have nothing to check itself');
    console.log('against.');
  } else {
    const facts = [
      ...labelled(style.dim, 'Branch', [repo.branch ?? 'unknown']),
      ...labelled(style.dim, 'Files', [`${repo.files} tracked in the git index`]),
      ...labelled(style.dim, 'Areas', [
        `${repo.areas.length} top-level ${repo.areas.length === 1 ? 'directory' : 'directories'}` +
          `${repo.areas.length ? ` (${repo.areas.slice(0, 8).join(', ')}${repo.areas.length > 8 ? ', …' : ''})` : ''}`,
      ]),
      ...labelled(style.dim, 'Stack', [repo.stack]),
      ...(repo.language
        ? labelled(style.dim, 'Language', [`${repo.language.label}, ${repo.language.count} of ${repo.files} files`])
        : []),
    ];
    for (const line of facts) console.log(line);
  }
  console.log('');

  const interactive = resolveInteractive(deps);

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

  if (!options.yes && !interactive) {
    const plan = await inspect(cwd, options);
    await displayPlan(plan, cwd, style);
    console.log(style.heading('Not written'));
    console.log('');
    console.log('This terminal cannot answer a question, so nothing was written. The exit');
    console.log('code is 2, so a script or CI step can tell "not done" from "done".');
    console.log('');
    console.log(`To accept the plan above:        ${style.flag(nasoCommand())} ${style.flag('--yes')} ${cwd}`);
    console.log(`To only print it, exiting 0:     ${style.flag(nasoCommand())} ${style.flag('--dry-run')} ${cwd}`);
    console.log('');
    process.exitCode = 2;
    return;
  }

  if (!options.yes) {
    const pkg = await readJSONFile(path.join(cwd, 'package.json'));
    const devDependency = devDependencyPlan(pkg, (await detectPackageManager(cwd, pkg)).name, version);
    const answered = await prompts.questions(style, options, { hook: state.hook, hasBlock: state.hasBlock, devDependency });
    if (answered === null) {
      prompts.done(style.warn('Cancelled. Nothing was written.'));
      return;
    }
    choices = { ...options, ...answered };
  }

  // Rejections are capped at two. A third would be somebody stuck rather than somebody
  // unconvinced, so after two the useful move is to stop and offer help. Excluding an
  // area is not a rejection: it changes the plan, and the plan is shown again.
  let rejections = 0;
  let detail = false;

  for (;;) {
    const plan = await inspect(cwd, choices);
    // A person at a terminal decides from the overview and asks for the rest; --yes prints
    // the full plan, because nobody will be asked and the log is the only record.
    if (options.yes || detail) await displayPlan(plan, cwd, style);
    else await displayOverview(plan, cwd, style);
    detail = false;

    if (plan.hookDecision.action === 'abort') {
      console.log(style.heading('Aborted'));
      console.log('');
      console.log('You chose to abort at the hook. Nothing was written.');
      console.log('');
      return;
    }

    if (options.yes) {
      console.log(style.dim('--yes: accepting the plan above.'));
      console.log('');
      const ok = await install(cwd, { ...choices, state: plan, style });
      if (!ok) process.exitCode = 1;
      return;
    }

    const installsHook = ['install', 'reinstall', 'chain'].includes(plan.hookDecision.action);
    const decision = await prompts.decide(style, { rejections, installsHook });

    if (decision === null) {
      prompts.done(style.warn('Cancelled. Nothing was written.'));
      return;
    }

    if (decision === 'accept') {
      console.log(style.dim('Accepted.'));
      console.log('');
      const ok = await install(cwd, { ...choices, state: plan, style });
      if (!ok) process.exitCode = 1;
      return;
    }

    if (decision === 'details') {
      detail = true;
      continue;
    }

    if (decision === 'exclude') {
      const areas = plan.facts.areas.filter((area) => !plan.excluded.includes(area.name));
      if (areas.length === 0) {
        console.log('Every top-level area is already excluded, or there are none. Nothing to pick.');
        console.log('');
        continue;
      }
      const picked = await prompts.pickArea(style, areas);
      if (picked === null) {
        prompts.done(style.warn('Cancelled. Nothing was written.'));
        return;
      }
      choices = { ...choices, exclude: [...new Set([...(choices.exclude ?? []), picked])].sort() };
      console.log(`${picked}/ will be left out of the briefing, and recorded in ${NASO_DIR}/config.json.`);
      console.log('');
      continue;
    }

    rejections++;
    console.log('');
    console.log(style.warn('Rejected. Nothing was written.'));
    console.log('');

    if (rejections < 2) {
      console.log('Reading the repository again, in case it changed.');
      console.log('');
      continue;
    }

    const finish = await prompts.afterRejections(style);
    if (finish === 'support') {
      console.log('');
      console.log(`Send this to ${SUPPORT_EMAIL}. Paste in the output above, and delete anything secret.`);
      console.log('');
      console.log('--------------------------------------------------------------');
      console.log(
        await supportTemplate({
          command: nasoCommand(),
          targetDir: cwd,
          version,
          now: new Date().toISOString().slice(0, 10),
        }),
      );
      console.log('--------------------------------------------------------------');
      console.log('');
    }
    console.log(`Nothing was written. ${cwd} is exactly as you found it.`);
    console.log('');
    return;
  }
}
