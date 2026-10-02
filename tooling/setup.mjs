#!/usr/bin/env node
// NASO Setup — steps 2 to 6 of the documented setup.
//
//   2. Read the repository. Show what was found and what would be written. Ask.
//   3. On accept: write AGENTS.md from the scan, install the hook, delete
//      anything a previous attempt left behind, verify, and print a prompt the
//      user can hand to their coding agent.
//   4. On a first reject: write nothing, read the repository again, show the plan
//      again. A rejection is information, not a verdict — the second read is a
//      fresh one, so a repository that changed in between gets a fresh plan.
//   5. On a second reject: offer support (contactmrval@gmail.com) or exit.
//   6. Support prints a pre-filled template. Exit removes NASO's leftovers and
//      leaves the repository as it was found.
//
// Two rules hold at every step. Nothing is written before the accept. And
// nothing is deleted that NASO did not write, without being told which file it is
// deleting — a tool that cleans up "helpfully" is a tool that eventually eats
// somebody's AGENTS.md.
//
// Usage:
//   npx naso-dev setup [target-dir] [--track] [--no-hook] [--force]
//                           [--yes] [--dry-run]
//
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  pathExists,
  parseArgs,
  run,
  toolVersion,
  actorIdentity,
  nasoDir,
  isInteractive,
  promptChoice,
  supportTemplate,
  isMainModule,
  TOOLS,
  SUPPORT_EMAIL,
} from './lib.mjs';
import { scanRepo, createBriefing, checkBriefing, printCheck, renderRootFiles, describeEntry } from './briefing.mjs';
import {
  installPreCommitHook,
  excludeLocally,
  findArtifacts,
  removeArtifacts,
  readHook,
  isNasoHook,
  LOCAL_EXCLUDE_PATTERNS,
} from './install.mjs';
import {
  NASO_DIR,
  readConfig,
  configuredExclusions,
  vendorTooling,
  writeConfig,
} from './vendor.mjs';

/** Greedy word wrap, for the explanatory paragraphs in the plan. */
const wrap = (text, width = 74) => {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n      ');
};

/**
 * The prompt to hand to the user's own coding agent after setup.
 *
 * Deliberately read-only. The first thing an agent does with a new AGENTS.md is
 * act on it — restructure, expand, "improve" — and the result is a briefing
 * nobody verified. Asking for an assessment first costs one turn and finds out
 * whether the briefing is any good before anything depends on it.
 */
function agentPrompt(cwd) {
  return `Copy everything between the lines below and paste it into your coding agent.

--------------------------------------------------------------
Read AGENTS.md in this repository (${cwd}).

Then, without creating, editing or deleting any file, and without running any
command that changes the repository, tell me:

1. What this repository is, in three sentences, and which parts of that came
   from AGENTS.md rather than from your own reading of the code.
2. What AGENTS.md tells you that you would not have found quickly on your own.
   Be concrete: name the sections.
3. Where AGENTS.md is incomplete, ambiguous, or wrong. Check its path claims
   against the filesystem before you say they are wrong.
4. What it changes about how you would work in this repository day to day —
   which questions you skip, which files you open first, which mistakes become
   impossible to make silently.
5. What you still cannot tell from AGENTS.md, and where in the code you would
   have to look to find out.

Do not propose changes to AGENTS.md yet. I want to see your reading of it first.
--------------------------------------------------------------`;
}

/**
 * Absolute paths of everything that gets copied into the repository, for display.
 *
 * The command-line tools come from `TOOLS`; the two libraries they share are listed
 * by hand, because they are not things anybody invokes. A preview that named only
 * the tools would understate the copy and invite the question of where `lock.mjs`
 * came from.
 */
function toolingTree() {
  const dir = path.join(nasoDir(), 'tooling');
  const entries = [
    { file: 'README.md', blurb: 'how to use, maintain and troubleshoot each tool' },
    { file: 'lib.mjs', blurb: 'shared helpers every tool imports' },
    { file: 'lock.mjs', blurb: 'the file lock, so two agents cannot write AGENTS.md at once' },
    { file: 'vendor.mjs', blurb: 'locates and refreshes this copy; reads .naso/config.json' },
  ];
  for (const tool of TOOLS) entries.push({ file: tool.file, blurb: tool.blurb });
  return entries.map((entry) => ({ ...entry, path: path.join(dir, entry.file) }));
}

/**
 * Everything step 2 knows, computed once.
 *
 * The scan is the expensive part and it is what both a rejection and an accept
 * are decided on, so it is done up front and reused for the whole flow.
 */
async function inspect(cwd, { track, noHook, exclude }) {
  const config = await readConfig(cwd);

  // Saved exclusions survive the run, and a --exclude flag adds to them. The union is
  // what the scan is filtered against, and the same union is handed to the write, so the
  // preview cannot disagree with what lands in AGENTS.md — a --exclude that only took
  // effect after the accept would be a lie the user caught one step too late.
  const savedExclusions = configuredExclusions(config);
  const excluded = [
    ...new Set([...savedExclusions, ...(Array.isArray(exclude) ? exclude : [])]),
  ].sort();

  const facts = await scanRepo(cwd, { exclude: excluded });
  const artifacts = await findArtifacts(cwd);
  const hook = await readHook(cwd);
  const version = await toolVersion();

  const plans = [];

  const agentsPath = path.join(cwd, 'AGENTS.md');
  const hasAgents = await pathExists(agentsPath);
  const existing = hasAgents ? await readFile(agentsPath, 'utf8').catch(() => '') : '';
  const hasBlock = existing.includes(NASO_START) && existing.includes(NASO_END);

  if (!hasAgents) {
    plans.push({
      target: 'AGENTS.md',
      verb: 'Write',
      detail: 'Generated from the scan below, wrapped in the naso:start / naso:end markers.',
    });
  } else if (hasBlock) {
    plans.push({
      target: 'AGENTS.md',
      verb: 'Keep',
      detail:
        'It already carries a NASO block. Everything you wrote around the markers is kept, and ' +
        'the block itself is left as it is — pass --force to regenerate just that block.',
    });
  } else {
    plans.push({
      target: 'AGENTS.md',
      verb: 'Append',
      detail:
        `${existing.split('\n').length} lines are already in it and none of them is ours. The NASO ` +
        'block goes at the end, between <!-- naso:start --> and <!-- naso:end -->. Nothing above or ' +
        'below those two markers is touched.',
    });
  }

  plans.push({
    target: `${NASO_DIR}/tooling/`,
    verb: 'Copy',
    detail:
      'Every script the gate needs, plus this tooling README and a VERSION file, are copied into ' +
      'this repository so the pre-commit hook keeps working with no package installed, no network, ' +
      'and no dependency on the npm cache.',
  });

  plans.push({
    target: `${NASO_DIR}/config.json`,
    verb: 'Write',
    detail:
      'The settings this run used: the mode, the version, and the areas you exclude from the ' +
      'briefing. Re-running setup rewrites it; `refresh` never does.',
  });

  if (noHook) {
    plans.push({
      target: '.git/hooks/pre-commit',
      verb: 'Skip',
      detail: '--no-hook was passed. Nothing will block a commit in this repository.',
    });
  } else if (hook && !isNasoHook(hook)) {
    plans.push({
      target: '.git/hooks/pre-commit',
      verb: 'Skip',
      detail:
        'A hook is already installed at this path and NASO did not write it. It is left exactly ' +
        'as it is — it may be running a lint config, a secret scanner, or a signing step.',
    });
  } else {
    plans.push({
      target: '.git/hooks/pre-commit',
      verb: 'Install',
      detail:
        `Runs ${NASO_DIR}/tooling/validate.mjs from this repository: the secret, scope, format and ` +
        'lint checks on staged files, plus the briefing upkeep.',
    });
  }

  plans.push(
    track
      ? {
          target: 'Tracking',
          verb: 'Track',
          detail:
            `--track was passed, so both ${NASO_DIR}/ and AGENTS.md are meant to be committed and ` +
            'reviewed like any other file. Commit both when you are ready.',
        }
      : {
          target: '.git/info/exclude',
          verb: 'Exclude',
          detail:
            `Keeps ${LOCAL_EXCLUDE_PATTERNS.join(' and ')} out of git entirely, and only on this ` +
            'machine. Set-up leaves no trace in the history, and no teammate gets a briefing ' +
            'generated for someone else’s machine. Pass --track to commit both instead.',
        },
  );

  return { facts, artifacts, hook, version, plans, excluded, hasAgents, hasBlock };
}

/** Step 2's screen. Printed identically on every pass, so a second read is comparable. */
function displayPlan(state, cwd) {
  const { facts, plans, version, excluded } = state;
  const dirs = facts.areas;
  const rootFiles = renderRootFiles(facts.entries);

  console.log(`# NASO Setup ${version} — ${cwd}`);
  console.log('');
  console.log(
    `Read ${facts.files.length} file${facts.files.length === 1 ? '' : 's'}` +
      `${facts.branch ? ` on ${facts.branch}` : ''}` +
      `${facts.pkg ? `, project "${facts.pkg.name ?? 'unnamed'}"` : ', no package.json'}.`,
  );
  console.log('');

  console.log('## AGENTS.md — what the briefing will say');
  console.log('');
  if (dirs.length === 0) {
    console.log('  No top-level directories. The briefing will describe the root files only.');
  } else {
    for (const entry of dirs) console.log(`  ${describeEntry(entry)}`);
  }
  if (rootFiles) console.log(`\n  ${rootFiles.split('\n').join('\n  ')}`);
  if (excluded.length > 0) {
    console.log('');
    console.log(`  Kept out of the briefing on request: ${excluded.map((p) => `${p}/`).join(', ')}`);
  }

  if (facts.validation.length > 0) {
    console.log('');
    console.log('  Validation commands it will record:');
    for (const command of facts.validation) console.log(`    ${command.command}`);
  }
  console.log('');

  console.log('## The toolset');
  console.log('');
  console.log(`These scripts are copied into ${NASO_DIR}/tooling/ in this repository:`);
  console.log('');
  for (const entry of toolingTree()) {
    console.log(`  ${path.basename(entry.path)}`);
    console.log(`      ${entry.blurb}`);
  }
  console.log('');
  console.log('The copy is why the hook survives: no package install, no network, no npm cache.');
  console.log('');

  console.log('## What will change');
  console.log('');
  for (const plan of plans) {
    console.log(`  ${plan.verb}  ${plan.target}`);
    console.log(`      ${wrap(plan.detail)}`);
  }
  console.log('');

  if (state.artifacts.length > 0) {
    console.log('## Leftovers to remove');
    console.log('');
    for (const artifact of state.artifacts) {
      console.log(`  ${artifact.path}`);
      console.log(`      ${artifact.note}`);
    }
    console.log('');
  }

  console.log('Nothing else is touched. No file outside the list above is read or written.');
  console.log('');
}

/** Step 3. */
async function install(cwd, { track, noHook, force, state }) {
  console.log('## Accepted — writing');
  console.log('');

  const created = await createBriefing(cwd, { force: force || (await pathExists(path.join(cwd, 'AGENTS.md'))) });

  if (created.ok) {
    const dirs = created.facts.entries.filter((entry) => entry.isDir);
    console.log(`- Wrote AGENTS.md from ${created.facts.files.length} files.`);
    for (const entry of dirs) console.log(`    ${describeEntry(entry)}`);
    const rootFiles = renderRootFiles(created.facts.entries);
    if (rootFiles) console.log(`    ${rootFiles.split('\n').join('\n    ')}`);
  } else {
    console.log(`- Skipped AGENTS.md: ${created.reason === 'locked' ? `locked by ${created.holder}` : 'already exists'}.`);
    console.log('  Nothing was overwritten.');
  }
  console.log('');

  if (!noHook) {
    const hook = await installPreCommitHook(cwd, {
      report: (line, kind) => console.log(`  ${line}`),
    });
    void hook;
    console.log('');
  } else {
    console.log('- Skipped the pre-commit hook (--no-hook).');
    console.log('');
  }

  if (!track) {
    const excluded = await excludeLocally(cwd);
    console.log(
      excluded
        ? `- Kept ${LOCAL_EXCLUDE_PATTERNS.join(' and ')} out of git via .git/info/exclude (this machine only, never committed).`
        : '- Could not update .git/info/exclude (no git repository here); those files are untracked.',
    );
  } else {
    console.log(`- Tracking ${NASO_DIR}/ and AGENTS.md in git, as --track asked. Commit both when ready.`);
  }
  console.log('');

  // Anything a previous attempt left behind goes now, while we are still the
  // process that created the mess. Only files NASO wrote are removed.
  const artifacts = await findArtifacts(cwd);
  const removable = artifacts.filter((artifact) => artifact.path !== path.join(cwd, 'AGENTS.md'));
  if (removable.length > 0) {
    const { removed } = await removeArtifacts(removable);
    for (const artifact of removed) console.log(`- Removed leftover ${artifact.label}.`);
    if (removed.length > 0) console.log('');
  }

  console.log('## Verify');
  console.log('');
  const verification = await checkBriefing(cwd);
  printCheck(verification);
  console.log('');
  console.log('Next:');
  console.log('');
  console.log(`  npx naso-dev briefing ${cwd}     re-check the briefing against the code`);
  console.log(`  npx naso-dev guide ${cwd}        read it back as a walkthrough`);
  console.log(`  npx naso-dev doctor ${cwd}       confirm the install end to end`);
  console.log('');
  console.log('## Hand this to your coding agent');
  console.log('');
  console.log(agentPrompt(cwd));

  return verification.ok;
}

/** Steps 5 and 6. */
async function afterSecondRejection(cwd, state) {
  console.log('## Declined twice');
  console.log('');
  console.log('Nothing has been written to this repository, and nothing will be.');
  console.log('');

  const choice = await promptChoice('How would you like to finish?', [
    { label: 'Contact support — print a pre-filled template' },
    { label: 'Exit — clean up any leftovers and leave this repository as it is' },
  ]);

  if (choice === 0) {
    console.log('');
    console.log(`Send this to ${SUPPORT_EMAIL}. Everything a maintainer would ask for is`);
    console.log('already in it; paste in the output and the state, and delete what is secret.');
    console.log('');
    console.log('--------------------------------------------------------------');
    console.log(
      await supportTemplate({
        command: 'naso setup',
        targetDir: cwd,
        version: state.version,
        actor: actorIdentity(),
        now: new Date().toISOString().slice(0, 10),
      }),
    );
    console.log('--------------------------------------------------------------');
    console.log('');
    console.log(`Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const artifacts = await findArtifacts(cwd);
  const { removed, kept } = await removeArtifacts(artifacts);

  console.log('');
  console.log('## Left as found');
  console.log('');
  if (removed.length === 0) {
    console.log('Nothing to clean up: this run wrote no files, and no earlier attempt left any.');
  } else {
    for (const artifact of removed) console.log(`- Removed ${artifact.path}`);
  }
  for (const artifact of kept) {
    console.log(`- Left ${artifact.path} in place (${artifact.note}).`);
  }
  console.log('');
  console.log(`${cwd} is exactly as you found it.`);
  if (kept.length > 0) {
    console.log('');
    console.log('To remove the files above as well, delete them yourself — NASO will not');
    console.log('guess which of them you care about.');
  }
  console.log('');
  console.log('If you change your mind later, nothing is lost:');
  console.log(`  npx naso-dev setup ${cwd}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values, positional } = parseArgs(argv);

  if (flags.has('help') || flags.has('h')) {
    console.log(`NASO setup

Usage:
  npx naso-dev setup [target-dir] [options]

  --track              commit ${NASO_DIR}/ and AGENTS.md instead of excluding them locally
  --no-hook            do not install the pre-commit hook
  --exclude <prefix>   keep an area out of the briefing; repeatable, saved to config.json
  --force              replace an existing naso:start / naso:end block, and nothing else
  --yes                accept without asking; for CI and scripts
  --dry-run            print the plan and stop

An AGENTS.md you wrote yourself is never replaced. NASO's content lives between
<!-- naso:start --> and <!-- naso:end -->, and nothing outside those markers is
touched, with or without --force.

With no --yes and no terminal, setup prints the plan and exits rather than
waiting for input nobody can type.

Support: ${SUPPORT_EMAIL}`);
    return;
  }

  const cwd = path.resolve(positional[0] ?? process.cwd());
  const options = {
    track: flags.has('track'),
    noHook: flags.has('no-hook'),
    force: flags.has('force'),
    yes: flags.has('yes') || flags.has('y'),
    dryRun: flags.has('dry-run'),
    exclude: (values.get('exclude') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev setup: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  if (!(await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })).ok) {
    console.log(`# NASO Setup — ${cwd}`);
    console.log('');
    console.log('Not a git repository. You can still get AGENTS.md and the toolset, but two');
    console.log('of the checks will have nothing to work with: the pre-commit hook needs a git');
    console.log('repository, and the scope check reads the staged diff.');
    console.log('');
    if (!options.yes && !isInteractive()) {
      console.log('Re-run with --yes to write it anyway.');
      return;
    }
    if (!options.yes) {
      const proceed = await promptChoice('Continue anyway?', [
        { label: 'Continue — write AGENTS.md and the toolset only' },
        { label: 'Stop — leave this directory alone' },
      ]);
      if (proceed !== 0) return;
    }
  }

  const interactive = isInteractive();
  if (!interactive && !options.yes && !options.dryRun) {
    // Print the plan, then stop. Anything else means blocking forever on a
    // prompt nobody can answer, which is how a CI job hangs until it is killed.
    const state = await inspect(cwd, options);
    displayPlan(state, cwd);
    console.log('## Next');
    console.log('');
    console.log('  This terminal cannot answer a question, so setup stopped before writing');
    console.log('  anything. Run it again in a terminal to accept or reject, or pass --yes');
    console.log('  to accept the plan above without asking.');
    console.log('');
    return;
  }

  // Rejections are capped at two. A third would be somebody stuck rather than somebody
  // unconvinced, and the useful move after two is to stop and let them come back with a
  // reason. Choosing "exclude" is not a rejection: it changes the plan and asks again.
  let rejections = 0;

  for (;;) {
    const state = await inspect(cwd, options);
    displayPlan(state, cwd);

    if (options.dryRun) {
      console.log('--dry-run: nothing was written.');
      return;
    }

    if (options.yes) {
      console.log('--yes: accepting the plan above.');
      console.log('');
      const ok = await install(cwd, { ...options, state });
      if (!ok) process.exitCode = 1;
      return;
    }

    const choice = await promptChoice(
      rejections === 0
        ? 'Accept this plan?'
        : 'Read the repository again and show you the plan again. Accept this one?',
      [
        { label: 'Accept — write the briefing, vendor the toolset, install the hook' },
        {
          label:
            rejections === 0
              ? 'Reject — write nothing and read the repository again'
              : 'Reject — write nothing and leave this repository as it is',
        },
        { label: 'Exclude an area — keep it out of the briefing, then show the plan again' },
      ],
    );

    if (choice === 0) {
      const ok = await install(cwd, { ...options, state });
      if (!ok) process.exitCode = 1;
      return;
    }

    if (choice === 2) {
      const areas = state.facts.areas.filter(
        (entry) => !state.excluded.includes(entry.name),
      );
      if (areas.length === 0) {
        console.log('');
        console.log('Every top-level area is already excluded, or there are none. Nothing to pick.');
        console.log('');
        continue;
      }
      const picked = await promptChoice(
        'Which area should the briefing ignore?',
        areas.map((entry) => ({ label: `${entry.name}/ — ${entry.files.length} files` })),
      );
      options.exclude = [...new Set([...options.exclude, areas[picked].name])].sort();
      console.log('');
      console.log(`${areas[picked].name}/ will be left out of the briefing, and recorded in`);
      console.log(`${NASO_DIR}/config.json so it stays out after a refresh.`);
      console.log('');
      continue;
    }

    rejections++;

    console.log('');
    console.log('Rejected. Nothing was written.');
    console.log('');

    if (rejections >= 2) {
      await afterSecondRejection(cwd, state);
      return;
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev setup: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
