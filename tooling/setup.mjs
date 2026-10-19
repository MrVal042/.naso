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
// Retired as a documented entry point: `npx naso-dev` with no command now does
// the explanation and the plan and the question in one run. The command still
// works and is still tested, because scripts in the wild call it, but it prints
// one deprecation line and gets out of the way.
//
// This module is the implementation the bare command calls into — inspect(),
// displayPlan() and install() are the same functions either path runs, which is
// what keeps the two from producing two different AGENTS.md files.
//
// Zero external dependencies — Node.js core modules only. The flow that calls in
// here brings the colour; none of it lives below this line, so the vendored copy
// of this file runs with no node_modules anywhere near it.

import path from 'node:path';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import {
  pathExists,
  parseArgs,
  listOption,
  run,
  toolVersion,
  nasoDir,
  plainStyle,
  isMainModule,
  readJSONFile,
  detectPackageManager,
  SUPPORT_EMAIL,
  nasoCommand,
  pinsExactVersions,
} from './lib.mjs';
import {
  scanRepo,
  createBriefing,
  checkBriefing,
  printCheck,
  renderRootFiles,
  describeEntry,
  scanWarnings,
  renderBriefing,
  appendBlock,
  plural,
  NASO_START,
  blockEdited,
  NASO_END,
} from './briefing.mjs';
import {
  installPreCommitHook,
  excludeLocally,
  pendingLocalExclusion,
  localExcludePatterns,
  planClaudeLink,
  claudeLinkContent,
  writeClaudeLink,
  findArtifacts,
  removeArtifacts,
  describeHook,
  buildHookScript,
  CHAINED_HOOK_NAME,
  LOCAL_EXCLUDE_PATTERNS,
} from './install.mjs';
import {
  NASO_DIR,
  readConfig,
  configuredExclusions,
  vendorTooling,
  vendorSources,
  vendoredText,
  writeConfig,
  renderConfig,
} from './vendor.mjs';
import { reviewPrompt } from './review.mjs';
import { indexFileOf } from './decisions.mjs';

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
 * Recording naso-dev as a dev dependency, with the repository's own package manager.
 *
 * `npm i naso-dev` lands in "dependencies", where a production install and an app's build
 * pull it in. A postinstall script cannot fix that or run setup: npm 7+ hides its output
 * and gives it no terminal, pnpm and bun do not run it at all by default, and npm writes
 * package.json after it. So setup does it, as one more line in the plan the person accepts.
 * yarn and bun keep an entry in "dependencies" when asked to add it as dev, so it is
 * removed first; npm and pnpm move it in one step. Null when there is no package.json.
 */
export function devDependencyPlan(pkg, pm, version, { exact = false } = {}) {
  if (!pkg) return null;
  if (pkg.devDependencies?.['naso-dev']) return { action: 'present', commands: [] };
  const spec = `naso-dev@${version}`;
  const pin = (flag) => (exact ? [flag] : []);
  const add = {
    npm: ['npm', ['install', '--save-dev', ...pin('--save-exact'), spec]],
    pnpm: ['pnpm', ['add', '--save-dev', ...pin('--save-exact'), spec]],
    yarn: ['yarn', ['add', '--dev', ...pin('--exact'), spec]],
    bun: ['bun', ['add', '--dev', ...pin('--exact'), spec]],
  }[pm] ?? ['npm', ['install', '--save-dev', ...pin('--save-exact'), spec]];
  const inDependencies = Boolean(pkg.dependencies?.['naso-dev']);
  const commands = inDependencies && (pm === 'yarn' || pm === 'bun') ? [[pm, ['remove', 'naso-dev']], add] : [add];
  return { action: inDependencies ? 'move' : 'add', pm, commands };
}

const commandText = ([bin, args]) => [bin, ...args].join(' ');

export { pinsExactVersions };

/** The lines NASO appends to an ignore file: its own comment, so it never sits under the team's. */
export function ignoreAppend(text) {
  const sep = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${sep}# Vendored by naso-dev; not part of this project's code\n${NASO_DIR}/\n`;
}

/** An ignore file that lacks .naso/, with what it holds now; null when it is covered. */
async function planIgnoreFile(cwd, name, { create }) {
  const file = path.join(cwd, name);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null && !create) return null;
  const covered = (text ?? '').split('\n').some((line) => /^\/?\.naso(?:\/\**)?$/.test(line.trim()));
  return covered ? null : { name, file, exists: text !== null, text: text ?? '', lines: lineCount(ignoreAppend(text ?? '')) };
}

/** Whether this repository uses Prettier and its .prettierignore lacks .naso/; null when nothing to do. */
async function planPrettierIgnore(cwd, facts) {
  const deps = facts.conventions?.deps ?? {};
  const usesPrettier = Boolean(facts.conventions?.prettierConfig || deps.prettier || facts.pkg?.prettier);
  return usesPrettier ? planIgnoreFile(cwd, '.prettierignore', { create: true }) : null;
}

/** The lockfile a package manager writes, for the plan's list of files. */
const LOCKFILE_OF = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' };

/** Lines in a text as an editor counts them: a trailing newline does not start one. */
export function lineCount(text) {
  const value = String(text);
  if (value === '') return 0;
  const lines = value.split('\n').length;
  return value.endsWith('\n') ? lines - 1 : lines;
}

/** A path for the plan: relative to the repository when it is inside it. */
const shown = (cwd, target) => {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : target;
};

/** What `--hook-action` accepts. */
export const HOOK_ACTIONS = ['install', 'chain', 'skip', 'abort'];

/**
 * What happens to the pre-commit hook, decided from what is there and what was asked.
 *
 * Pure, so the plan and the write cannot disagree. The defaults never touch a hook NASO
 * did not write and never write into a hooks directory git tracks: both need an explicit
 * choice — an answer to the question, or `--hook-action` — and in their absence the hook
 * is skipped and the plan says why.
 *
 *   install / reinstall   the slot is empty, or already NASO's
 *   chain                 move the foreign hook aside, byte for byte; NASO's calls it first
 *   skip                  write no hook
 *   abort                 write nothing at all
 */
export function decideHook(hook, { noHook = false, hookAction = null } = {}) {
  if (noHook) return { action: 'skip', reason: 'no-hook' };
  if (hook.state === 'not-repo') return { action: 'skip', reason: 'not-a-repo' };
  const conflicted = hook.state === 'foreign' || hook.trackedDir;
  if (hookAction === 'abort' && conflicted) return { action: 'abort', reason: 'chosen' };
  if (hookAction === 'skip') return { action: 'skip', reason: 'chosen' };

  if (hook.state === 'foreign') {
    return hookAction === 'chain'
      ? { action: 'chain', allowTracked: hook.trackedDir }
      : { action: 'skip', reason: 'foreign' };
  }
  const fresh = hook.state === 'naso' ? 'reinstall' : 'install';
  if (hook.trackedDir) {
    return hookAction === 'install' || hookAction === 'chain'
      ? { action: fresh, allowTracked: true }
      : { action: 'skip', reason: 'tracked-dir' };
  }
  return { action: fresh, allowTracked: false };
}

/** The plan's line for the hook. Every branch names the path, so nothing is implied. */
function hookPlanEntry(hook, decision) {
  if (decision.reason === 'no-hook') {
    return { target: hook.path ?? '.git/hooks/pre-commit', verb: 'Skip', detail: '--no-hook was passed. Nothing will block a commit in this repository.' };
  }
  if (decision.reason === 'not-a-repo') {
    return { target: 'pre-commit hook', verb: 'Skip', detail: 'Not a git repository, so there is no hook to install.' };
  }
  const gate = `Runs ${NASO_DIR}/tooling/validate.mjs from this repository: the secret, scope, format and lint checks on staged files, plus the briefing upkeep.`;
  if (hook.state === 'foreign') {
    const target = `Hook: existing hook at ${hook.path}`;
    if (decision.action === 'chain') {
      return {
        target,
        verb: 'Chain',
        detail:
          `It is moved, unchanged, to ${CHAINED_HOOK_NAME} beside it, and NASO's hook calls it first: ` +
          `if it fails, the commit stops as it does today. ${gate}` +
          (hook.trackedDir ? ` core.hooksPath (${hook.hooksPath}) is tracked, so both files show up in git status.` : ''),
      };
    }
    if (decision.action === 'abort') return { target, verb: 'Abort', detail: 'Nothing will be written.' };
    return {
      target,
      verb: 'Skip',
      detail:
        'NASO did not write it, so it is left exactly as it is — it may run a lint config, a secret ' +
        'scanner or a signing step. Choose chain (or pass --hook-action chain) to run both.',
    };
  }
  if (hook.trackedDir) {
    const target = `Hook: ${hook.path}`;
    if (decision.action === 'skip') {
      return {
        target,
        verb: 'Skip',
        detail:
          `core.hooksPath is ${hook.hooksPath}, a directory git tracks, so a hook written there would be ` +
          'part of the next commit. NASO does not write there unless you choose it (--hook-action install).',
      };
    }
    if (decision.action === 'abort') return { target, verb: 'Abort', detail: 'Nothing will be written.' };
    return {
      target,
      verb: decision.action === 'reinstall' ? 'Reinstall' : 'Install',
      detail: `${gate} You chose to write into ${hook.hooksPath}, which git tracks: the hook will show up in git status.`,
    };
  }
  return {
    target: hook.path,
    verb: decision.action === 'reinstall' ? 'Reinstall' : 'Install',
    detail: decision.action === 'reinstall' ? `NASO's own hook, rewritten in place. ${gate}` : gate,
  };
}

const CLAUDE_ADVICE =
  'Claude Code reads CLAUDE.md, not AGENTS.md, and this CLAUDE.md is tracked in git and does ' +
  'not load the briefing: add `@AGENTS.md` to CLAUDE.md, or re-run with --track to let setup ' +
  'append it.';

/** Why CLAUDE.md is not NASO's to edit, in the repository's words, or null. */
function claudeProtection(facts) {
  const note = (facts.ignoreNotes ?? []).find((entry) => entry.path === 'CLAUDE.md' && entry.kind === 'protected');
  if (note) return `${note.source} marks it "${note.note}"`;
  const owner = (facts.codeowners?.entries ?? []).find((entry) => /^\/?CLAUDE\.md$/.test(entry.pattern));
  if (owner) return `${facts.codeowners.path} gives it to ${owner.owners.join(', ')}`;
  return null;
}

const claudeProtectedAdvice = (claude) =>
  `Left as it is: ${claude.reason}. Claude Code reads CLAUDE.md, not AGENTS.md, so ask whoever ` +
  'maintains it to add `@AGENTS.md`; until then Claude Code sessions start without the briefing.';

/** The plan line for CLAUDE.md, in the same words the write will report. */
function claudePlanEntry(claude) {
  const detail = {
    linked: 'It already names AGENTS.md, so Claude Code sessions load the briefing. Left as it is.',
    create:
      'Claude Code reads CLAUDE.md, not AGENTS.md. A CLAUDE.md holding one `@AGENTS.md` line, ' +
      'inside naso markers, makes every Claude Code session start with the briefing.',
    append:
      'Claude Code reads CLAUDE.md, not AGENTS.md. One `@AGENTS.md` line, inside naso markers, ' +
      'goes below what is there; nothing above it changes.',
    advise: CLAUDE_ADVICE,
    protected: claude.action === 'protected' ? claudeProtectedAdvice(claude) : null,
  }[claude.action];
  const verb = { linked: 'Keep', create: 'Write', append: 'Append', advise: 'Leave', protected: 'Leave' }[claude.action];
  return { target: 'CLAUDE.md', verb, detail };
}

const TRACKED_AGENTS_NOTE =
  'AGENTS.md is tracked in git already, and an exclude line cannot hide a tracked file: the ' +
  'NASO block shows in git status as a change to AGENTS.md. Commit it to share the briefing, ' +
  'or `git checkout -- AGENTS.md` to drop it.';

/**
 * Everything step 2 knows, computed once.
 *
 * The scan is the expensive part and it is what both a rejection and an accept
 * are decided on, so it is done up front and reused for the whole flow.
 */
export async function inspect(cwd, { track, noHook, exclude, force = false, hookAction = null, saveDev = false, discardEdits = false }) {
  const config = await readConfig(cwd);

  // Saved exclusions survive the run, and a --exclude flag adds to them. The union is
  // what the scan is filtered against, and the same union is handed to the write, so the
  // preview cannot disagree with what lands in AGENTS.md — a --exclude that only took
  // effect after the accept would be a lie the user caught one step too late.
  const savedExclusions = configuredExclusions(config);
  const excluded = [
    ...new Set([...savedExclusions, ...(Array.isArray(exclude) ? exclude : [])]),
  ].sort();

  const claude = await planClaudeLink(cwd, { track });
  // A CLAUDE.md this run creates holds nothing but the link, so it is as local as AGENTS.md.
  const localExcludes = track
    ? []
    : [...(await localExcludePatterns(cwd)), ...(claude.action === 'create' ? ['CLAUDE.md'] : [])];
  const pendingExclude = track ? null : await pendingLocalExclusion(cwd, localExcludes);
  const facts = await scanRepo(cwd, {
    exclude: excluded,
    pendingLocalExcludes: pendingExclude?.missing ?? [],
  });
  // A CLAUDE.md the repository marks as someone else's is not NASO's to append to, --track
  // or not: the standards it came from would overwrite the line, or a review would refuse it.
  if (claude.action === 'append' || claude.action === 'advise') {
    const protectedBy = claudeProtection(facts);
    if (protectedBy) Object.assign(claude, { action: 'protected', reason: protectedBy });
  }
  const artifacts = await findArtifacts(cwd);
  const hook = await describeHook(cwd);
  const hookDecision = decideHook(hook, { noHook, hookAction });
  const version = await toolVersion();

  const plans = [];

  const agentsPath = path.join(cwd, 'AGENTS.md');
  const hasAgents = await pathExists(agentsPath);
  const existing = hasAgents ? await readFile(agentsPath, 'utf8').catch(() => '') : '';
  const hasBlock = existing.includes(NASO_START) && existing.includes(NASO_END);
  const edited = hasBlock && blockEdited(existing);
  // A reviewed block is kept whatever --force says; only --discard-edits replaces it.
  if (edited && !discardEdits) force = false;

  if (!hasAgents) {
    plans.push({
      target: 'AGENTS.md',
      verb: 'Write',
      detail: 'Generated from the scan below, wrapped in the naso:start / naso:end markers.',
    });
  } else if (hasBlock && force) {
    plans.push({
      target: 'AGENTS.md',
      verb: 'Replace',
      detail:
        'The NASO block between <!-- naso:start --> and <!-- naso:end --> is regenerated from the ' +
        'scan. Every line outside those markers stays byte for byte as it is.',
    });
  } else if (hasBlock && edited) {
    plans.push({
      target: 'AGENTS.md',
      verb: 'Keep',
      detail:
        'The NASO block was edited after NASO wrote it, so it is kept exactly as it is: a ' +
        'regenerate never replaces reviewed corrections. Pass --discard-edits to replace it; ' +
        'the old block is saved under .naso/backups/ first.',
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

  plans.push(claudePlanEntry(claude));

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
      'The settings this run used: the mode, the version setup ran with (setupVersion), and the areas you exclude from the ' +
      'briefing. Re-running setup rewrites it; `refresh` never does.',
  });

  plans.push(hookPlanEntry(hook, hookDecision));

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
            localExcludes.length === 0
              ? `Nothing to exclude: ${LOCAL_EXCLUDE_PATTERNS.join(' and ')} are tracked in git already, ` +
                'so the changes this run makes show in git status like any other.'
              : `Keeps ${localExcludes.join(' and ')} out of git entirely, and only on this ` +
                'machine. Set-up leaves no trace in the history, and no teammate gets a briefing ' +
                'generated for someone else’s machine. ' +
                (localExcludes.includes('AGENTS.md')
                  ? 'Pass --track to commit both instead.'
                  : TRACKED_AGENTS_NOTE),
        },
  );

  // Every file this run writes, with the exact line count of what lands there. Computed
  // from the same renderers the write uses, so the preview is the write, not a summary.
  const now = new Date().toISOString().slice(0, 10);
  const block = await renderBriefing(facts, { version, now });
  const writes = [];
  if (!hasAgents) {
    writes.push({ path: 'AGENTS.md', change: 'new', lines: lineCount(block) });
  } else if (!hasBlock) {
    writes.push({
      path: 'AGENTS.md',
      change: 'append',
      lines: lineCount(appendBlock(existing, block)) - lineCount(existing),
      note: 'below the lines already there, which are not changed',
    });
  } else if (force) {
    writes.push({ path: 'AGENTS.md', change: 'replace block', lines: lineCount(block), note: 'only between the markers' });
  }

  if (claude.action === 'create' || claude.action === 'append') {
    const after = claudeLinkContent(claude);
    writes.push(
      claude.action === 'create'
        ? { path: 'CLAUDE.md', change: 'new', lines: lineCount(after) }
        : { path: 'CLAUDE.md', change: 'append', lines: lineCount(after) - lineCount(claude.before), note: 'the link, below what is there' },
    );
  }

  for (const source of await vendorSources()) {
    const rel = `${NASO_DIR}/tooling/${path.basename(source)}`;
    writes.push({
      path: rel,
      change: (await pathExists(path.join(cwd, rel))) ? 'replace' : 'new',
      lines: lineCount(vendoredText(source, await readFile(source, 'utf8'))),
    });
  }
  const versionRel = `${NASO_DIR}/tooling/VERSION`;
  writes.push({ path: versionRel, change: (await pathExists(path.join(cwd, versionRel))) ? 'replace' : 'new', lines: 1 });

  const configRel = `${NASO_DIR}/config.json`;
  writes.push({
    path: configRel,
    change: (await pathExists(path.join(cwd, configRel))) ? 'replace' : 'new',
    lines: lineCount(renderConfig({ version, now, track, hook: hookDecision.action !== 'skip', exclude: excluded })),
  });

  if (pendingExclude?.text) {
    writes.push({ path: shown(cwd, pendingExclude.path), change: 'append', lines: lineCount(pendingExclude.text) });
  }

  if (['install', 'reinstall', 'chain'].includes(hookDecision.action)) {
    if (hookDecision.action === 'chain') {
      writes.push({
        path: shown(cwd, path.join(hook.hooksDir, CHAINED_HOOK_NAME)),
        change: 'moved here',
        lines: lineCount(await readFile(hook.path, 'utf8').catch(() => '')),
        note: `the existing ${path.basename(hook.path)}, byte for byte`,
      });
    }
    writes.push({
      path: shown(cwd, hook.path),
      change: hook.state === 'naso' ? 'replace' : 'new',
      lines: lineCount(buildHookScript()),
    });
  }

  // Prettier reads .gitignore and .prettierignore, never .git/info/exclude, so a local
  // .naso/ is still formatted-checked by `prettier --check .` and fails it. One line in
  // .prettierignore is the only switch Prettier has.
  const prettierIgnore = await planPrettierIgnore(cwd, facts);
  if (prettierIgnore) {
    plans.push({
      target: '.prettierignore',
      verb: prettierIgnore.exists ? 'Append' : 'Write',
      detail:
        `One line, ${NASO_DIR}/, so \`prettier --check\` leaves the copied toolset alone. Prettier does not ` +
        'read .git/info/exclude, and the scripts are formatted for this project, not yours.',
    });
    writes.push({ path: '.prettierignore', change: prettierIgnore.exists ? 'append' : 'new', lines: prettierIgnore.lines });
  }

  // `COPY . .` sends the build context to Docker, and .git/info/exclude does not reach it:
  // without this line the toolset is baked into the team's image. Only an existing
  // .dockerignore is appended to; a repository with none is not given one.
  const dockerIgnore = await planIgnoreFile(cwd, '.dockerignore', { create: false });
  if (dockerIgnore) {
    plans.push({
      target: '.dockerignore',
      verb: 'Append',
      detail: `${NASO_DIR}/, so a Docker build does not copy the toolset into the image. Docker does not read .git/info/exclude.`,
    });
    writes.push({ path: '.dockerignore', change: 'append', lines: dockerIgnore.lines });
  }

  const devDependency = devDependencyPlan(facts.pkg, facts.packageManager?.name ?? 'npm', version, { exact: await pinsExactVersions(cwd, facts.pkg) });
  const recordsDev = Boolean(saveDev && devDependency && devDependency.action !== 'present');
  if (recordsDev) {
    const how = devDependency.commands.map(commandText).join(' && ');
    plans.push({
      target: 'naso-dev to devDependencies',
      verb: devDependency.action === 'move' ? 'Move' : 'Add',
      detail:
        (devDependency.action === 'move'
          ? 'It is in "dependencies", where a production install and the app\'s build pick it up. '
          : 'Teammates get the same version from an ordinary install, and production installs leave it out. ') +
        `Runs \`${how}\` last, after everything else is written. This is the only step that uses the network.`,
    });
    // The package manager writes these, so NASO cannot promise a line count; the row says who.
    writes.push({ path: 'package.json', change: 'by-pm', lines: 0, note: `devDependencies, by ${devDependency.pm}, last` });
    writes.push({ path: LOCKFILE_OF[devDependency.pm] ?? 'package-lock.json', change: 'by-pm', lines: 0, note: `by ${devDependency.pm}, with node_modules/` });
  }

  return { facts, artifacts, hook, hookDecision, version, plans, writes, excluded, hasAgents, hasBlock, blockEdited: edited, force, localExcludes, claude, devDependency, recordsDev, track, ignoreFiles: [prettierIgnore, dockerIgnore].filter(Boolean) };
}

/**
 * The overview a person decides from: what the briefing will cover, any warning, and one row
 * per destination with its exact line count.
 *
 * The toolset is one row. Sixteen script names tell a person deciding nothing that
 * "16 files, N lines, the hook runs this copy" does not, and the full list is one answer
 * away ("Show details"), which is also what --dry-run and a script without a terminal print.
 */
export async function displayOverview(state, cwd, style = plainStyle) {
  const { facts, excluded } = state;
  const name = facts.pkg?.name ?? path.basename(cwd);

  console.log(`${style.bold(`The plan for ${name}`)}  ${style.dim('nothing is written until you accept')}`);
  console.log('');

  const areas = facts.areas.map((entry) => `${entry.name}/`);
  console.log(
    `  The briefing covers ${plural(areas.length, 'area')}${areas.length ? `: ${areas.slice(0, 8).join(', ')}${areas.length > 8 ? ', …' : ''}` : ''}` +
      ` from ${plural(facts.files.length, 'file')}${facts.branch ? ` on ${facts.branch}` : ''}.`,
  );
  if (excluded.length > 0) console.log(`  Left out on request: ${excluded.map((p) => `${p}/`).join(', ')}`);
  const gate = facts.gate?.command
    ? facts.gate.command
    : facts.gate?.ciFile
      ? `${facts.gate.ciFile} (${plural(facts.gate.jobs.length, 'CI job')})`
      : facts.validation.map((command) => command.command).join(', ');
  if (gate) console.log(`  What must pass: ${gate}`);

  const warnings = await scanWarnings(facts);
  for (const warning of warnings) console.log(`  ${style.warn(warning.headline)}  ${style.dim('(Show details)')}`);
  console.log('');

  const tooling = state.writes.filter((write) => write.path.startsWith(`${NASO_DIR}/tooling/`));
  const rows = [];
  let toolingShown = false;
  for (const write of state.writes) {
    if (!write.path.startsWith(`${NASO_DIR}/tooling/`)) {
      rows.push(write);
      continue;
    }
    if (toolingShown) continue;
    toolingShown = true;
    rows.push({
      path: `${NASO_DIR}/tooling/`,
      change: tooling.every((write) => write.change === 'new') ? 'new' : 'replace',
      lines: tooling.reduce((sum, write) => sum + write.lines, 0),
      note: `${plural(tooling.length, 'file')}; the hook runs this copy`,
    });
  }
  const notes = {
    'AGENTS.md': 'the briefing',
    'CLAUDE.md': 'makes Claude Code load the briefing',
    [`${NASO_DIR}/config.json`]: 'the choices you made here',
  };

  console.log(style.heading('Files this writes'));
  console.log('');
  const width = Math.max(...rows.map((row) => row.path.length)) + 2;
  for (const row of rows) {
    const size = sizeText(row);
    const note = row.note ?? notes[row.path] ?? (/pre-commit$/.test(row.path) ? 'the gate, on this machine' : null);
    console.log(`  ${row.path.padEnd(width)}${size}${note ? `  ${style.dim(`(${note})`)}` : ''}`);
  }
  console.log('');
  console.log(
    `  ${plural(state.writes.length, 'file')}, ${plural(state.writes.reduce((n, w) => n + w.lines, 0), 'line')}. ` +
      `${state.track ? 'Yours to commit.' : 'Kept out of git on this machine.'} Nothing else is written.`,
  );
  if (state.recordsDev) {
    console.log(`  Last, \`${state.devDependency.commands.map(commandText).join(' && ')}\`, the only step that uses the network.`);
  }
  console.log('');
}

/** "new, 83 lines", "append 5 lines", or "changed" for a file the package manager writes. */
function sizeText(write) {
  if (write.change === 'by-pm') return 'changed';
  if (write.change === 'append') return `append ${plural(write.lines, 'line')}`;
  return `${write.change}, ${plural(write.lines, 'line')}`;
}

/** Step 2's screen. Printed identically on every pass, so a second read is comparable. */
export async function displayPlan(state, cwd, style = plainStyle) {
  const { facts, plans, version, excluded } = state;
  const dirs = facts.areas;
  const rootFiles = renderRootFiles(facts.entries, facts);

  console.log(`${style.bold('The plan')}  ${style.dim(cwd)}`);
  console.log('');
  console.log(
    `Read ${facts.files.length} file${facts.files.length === 1 ? '' : 's'}` +
      `${facts.branch ? ` on ${facts.branch}` : ''}` +
      `${facts.pkg ? `, project "${facts.pkg.name ?? 'unnamed'}"` : ', no package.json'}.`,
  );
  console.log('');

  console.log(style.heading('AGENTS.md — what the briefing will say'));
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

  const warnings = await scanWarnings(facts);
  if (warnings.length > 0) {
    console.log('');
    console.log('  Warnings — NASO changed none of these, they are here so you see them:');
    for (const warning of warnings) {
      console.log(`    ${style.warn(warning.headline)}`);
      console.log(`      ${style.dim(warning.detail)}`);
    }
  }
  console.log('');

  console.log(style.heading('Files this writes'));
  console.log('');
  const width = Math.max(...state.writes.map((write) => write.path.length)) + 2;
  for (const write of state.writes) {
    const size = sizeText(write);
    console.log(`  ${write.path.padEnd(width)}${size}${write.note ? `  ${style.dim(`(${write.note})`)}` : ''}`);
  }
  const hookEntry = plans.find((plan) => plan.target.startsWith('Hook:') || /pre-commit/.test(plan.target));
  console.log('');
  console.log(`  ${plural(state.writes.length, 'file')}, ${plural(state.writes.reduce((n, w) => n + w.lines, 0), 'line')}.`);
  if (hookEntry) console.log(`  Hook decision: ${hookEntry.verb.toLowerCase()} — ${hookEntry.target.replace(/^Hook: /, '')}`);
  console.log('');

  console.log(style.heading('What will change'));
  console.log('');
  for (const plan of plans) {
    console.log(`  ${style.bullet(`${style.bold(plan.verb)}  ${plan.target}`)}`);
    console.log(`      ${wrap(plan.detail)}`);
  }
  console.log('');

  if (state.artifacts.length > 0) {
    console.log(style.heading('Leftovers to remove'));
    console.log('');
    for (const artifact of state.artifacts) {
      console.log(`  ${artifact.path}`);
      console.log(`      ${artifact.note}`);
    }
    console.log('');
  }

  console.log('Nothing outside the files listed above is written.');
  console.log('');
}

/** Step 3. */
export async function install(cwd, { track, noHook, force, discardEdits = false, state, style = plainStyle }) {
  const done = { hook: false, claude: false, dev: false };
  // A tick that survives no-colour output: plainStyle has no glyphs of its own.
  const ok = (text) => `${style.green ? style.green('✓') : '✓'} ${text}`;
  const no = (text) => `${style.yellow ? style.yellow('!') : '!'} ${text}`;
  console.log('## Accepted — writing');
  console.log('');

  const decision = state.hookDecision ?? decideHook(await describeHook(cwd), { noHook });

  // The local excludes go in before the briefing is written, not after. The Boundaries
  // section reports what .git/info/exclude holds, and a briefing generated one step before
  // those lines existed would describe the mechanism and not its contents — which is the
  // one thing the reader cannot work out alone, since nobody else has this file either.
  const localExcludes = state.localExcludes ?? (await localExcludePatterns(cwd));
  const excludedLocally = track ? false : await excludeLocally(cwd, localExcludes);

  const created = await createBriefing(cwd, { force: state.force ?? force, discardEdits, exclude: state.excluded });

  // The areas were on screen in the plan a moment ago; printing them again here pushed the
  // prompt this run ends with off the top of a normal terminal.
  if (created.ok) {
    const lines = lineCount(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8').catch(() => ''));
    if (created.appended) {
      console.log(ok(`AGENTS.md: wrote the NASO block below your ${created.existingLines} lines, which are unchanged`));
    } else if (created.replacedBlock) {
      console.log(ok(`AGENTS.md: wrote the NASO block in place of the old one; your ${created.existingLines} other lines are unchanged`));
      if (created.backup) console.log(`    the edited block was saved to ${created.backup}`);
    } else {
      console.log(ok(`AGENTS.md: wrote the NASO block, ${plural(lines, 'line')}`));
    }
  } else if (created.reason === 'edited' || (created.reason === 'has-block' && state.blockEdited)) {
    console.log(ok('AGENTS.md: kept your edited NASO block as it is (--discard-edits replaces it, after a backup)'));
  } else if (created.reason === 'has-block') {
    console.log(ok('AGENTS.md: kept the existing NASO block as it is (--force regenerates it)'));
  } else {
    console.log(
      no(`AGENTS.md: left alone, ${created.reason === 'locked' ? `locked by ${created.holder}` : created.reason}. Nothing outside the markers is ever rewritten.`),
    );
  }

  const claude = state.claude ?? (await planClaudeLink(cwd, { track }));
  const claudeWritten = await writeClaudeLink(claude);
  done.claude = claudeWritten || claude.action === 'linked';
  if (claudeWritten) {
    console.log(ok(`CLAUDE.md: ${claude.action === 'create' ? 'wrote' : 'appended'} \`@AGENTS.md\`, so Claude Code loads the briefing`));
  } else if (claude.action === 'advise') {
    console.log(no(`CLAUDE.md: left alone. ${CLAUDE_ADVICE}`));
  } else if (claude.action === 'protected') {
    console.log(no(`CLAUDE.md: ${claudeProtectedAdvice(claude)}`));
  } else {
    console.log(ok('CLAUDE.md: already loads AGENTS.md'));
  }

  const vendored = await vendorTooling(cwd);
  console.log(ok(`${NASO_DIR}/tooling/: copied ${plural(vendored.length, 'file')}; the hook runs this copy, not the package`));

  await writeConfig(cwd, {
    version: state.version,
    now: new Date().toISOString().slice(0, 10),
    track,
    hook: decision.action !== 'skip',
    exclude: state.excluded,
  });
  console.log(ok(`${NASO_DIR}/config.json: wrote the settings this run used`));

  for (const { name, file, text } of state.ignoreFiles ?? []) {
    await writeFile(file, `${text}${ignoreAppend(text)}`, 'utf8');
    console.log(
      ok(
        name === '.prettierignore'
          ? `.prettierignore: added ${NASO_DIR}/, so prettier --check leaves the toolset alone`
          : `${name}: added ${NASO_DIR}/, so a Docker build leaves the toolset out of the image`,
      ),
    );
  }

  if (decision.action === 'install' || decision.action === 'reinstall' || decision.action === 'chain') {
    done.hook = true;
    const reported = [];
    await installPreCommitHook(cwd, {
      action: decision.action === 'chain' ? 'chain' : 'install',
      allowTracked: Boolean(decision.allowTracked),
      report: (line) => reported.push(line),
    });
    console.log(ok(`pre-commit hook: ${decision.action === 'chain' ? 'installed, running your existing hook first' : 'installed'} (${shown(cwd, state.hook?.path ?? path.join(cwd, '.git/hooks/pre-commit'))})`));
    for (const line of reported.filter((line) => /could not|failed|warn/i.test(line))) console.log(`    ${line}`);
  } else {
    const why = {
      'no-hook': '--no-hook',
      'not-a-repo': 'not a git repository',
      foreign: `${state.hook?.path} is not NASO's and was left as it is`,
      'tracked-dir': `core.hooksPath ${state.hook?.hooksPath} is tracked by git`,
      chosen: 'you chose to skip it',
    }[decision.reason] ?? decision.reason;
    console.log(no(`pre-commit hook: skipped (${why}). Run the gate by hand: node ${NASO_DIR}/tooling/validate.mjs --staged`));
  }

  if (!track) {
    console.log(
      excludedLocally && localExcludes.length === 0
        ? ok(`git: excluded nothing; ${LOCAL_EXCLUDE_PATTERNS.join(' and ')} are tracked already`)
        : excludedLocally
        ? ok(`git: ${localExcludes.join(', ')} kept out via .git/info/exclude, on this machine only`)
        : no('git: no repository here, so nothing was excluded; those files are untracked'),
    );
    if (excludedLocally && localExcludes.length > 0 && !localExcludes.includes('AGENTS.md')) console.log(`    ${TRACKED_AGENTS_NOTE}`);
  } else {
    console.log(ok(`git: ${NASO_DIR}/ and AGENTS.md are yours to commit (--track)`));
  }

  // Anything a previous attempt left behind goes now, while we are still the
  // process that created the mess. Only files NASO wrote are removed.
  const artifacts = await findArtifacts(cwd);
  if (artifacts.length > 0) {
    const { removed, failed } = await removeArtifacts(artifacts);
    for (const artifact of removed) console.log(ok(`removed leftover ${artifact.label}`));
    for (const artifact of failed) {
      console.log(no(`could not remove leftover ${artifact.label} (${artifact.error}); delete ${artifact.path} by hand`));
    }
  }

  if (state.recordsDev) {
    // Last, so a failed install leaves a finished setup rather than a half-written one.
    let failed = null;
    for (const command of state.devDependency.commands) {
      const res = await run(command[0], command[1], { cwd });
      if (!res.ok) {
        failed = { command, res };
        break;
      }
    }
    const how = state.devDependency.commands.map(commandText).join(' && ');
    // An exit code of 0 is the package manager's claim; package.json is the fact.
    const after = failed ? null : await readJSONFile(path.join(cwd, 'package.json'));
    if (!failed && !after?.devDependencies?.['naso-dev']) {
      failed = { command: state.devDependency.commands.at(-1), res: { stderr: 'it exited 0, but package.json has no devDependencies entry for naso-dev' } };
    }
    if (failed) {
      const why = (failed.res.stderr || failed.res.stdout).trim().split('\n').slice(-3).join('\n    ');
      console.log(no(`devDependencies: could not record naso-dev; \`${commandText(failed.command)}\` failed`));
      if (why) console.log(`    ${why}`);
      console.log(`    Everything else is written. Run it yourself: ${how}`);
    } else {
      done.dev = true;
      console.log(ok(`devDependencies: ${state.devDependency.action === 'move' ? 'moved' : 'added'} naso-dev with \`${how}\``));
    }
  }
  console.log('');

  console.log('## Verify');
  console.log('');
  const verification = await checkBriefing(cwd);
  printCheck(verification);
  console.log('');
  console.log('## What you have now');
  console.log('');
  for (const line of benefits({ verification, track, done, state })) console.log(`- ${line}`);
  console.log('');

  // From inside the repository a path adds nothing but width, and four copies of a long
  // one wrapped the commands into a block nobody could paste from.
  // Real paths: on macOS /var is a link to /private/var, and process.cwd() resolves it.
  const real = (dir) => realpath(dir).catch(() => path.resolve(dir));
  const here = (await real(process.cwd())) === (await real(cwd)) ? '' : ` ${cwd}`;
  const commands = [
    [`${nasoCommand()} briefing${here}`, 're-check the briefing against the code'],
    [`${nasoCommand()} review${here}`, 'this prompt again, with the state at that time'],
    [`${nasoCommand()} guide${here}`, 'the guide for one area'],
    [`${nasoCommand()} doctor${here}`, 'confirm the install end to end'],
    [`${nasoCommand()} refresh${here}`, 'after upgrading: re-copy the toolset and re-stamp'],
  ];
  const width = Math.max(...commands.map(([command]) => command.length)) + 3;
  console.log('Later:');
  console.log('');
  for (const [command, why] of commands) console.log(`  ${command.padEnd(width)}${why}`);
  console.log('');

  // The prompt is last because it is the next thing to do: the agent finishes what NASO
  // cannot derive, and a person copying it should not have to scroll back to find it.
  console.log('## Last step: hand this to your coding agent');
  console.log('');
  console.log(await reviewPrompt(cwd, { here }));

  return verification.ok;
}

/**
 * What this run gave the repository, one line per thing that actually happened.
 *
 * Built from the outcome, not the plan: a skipped hook is not described as a gate, and a
 * failed install is not described as a dev dependency. A list of benefits the run did not
 * deliver would be the last thing on screen and the first thing proven wrong.
 */
function benefits({ verification, track, done, state }) {
  const lines = [];
  const claims = verification.tokens?.length ?? 0;
  if (verification.ok) {
    lines.push(
      `A briefing every coding agent that reads AGENTS.md starts from, with ${plural(claims, 'path claim')} ` +
        'checked against this repository rather than written from memory.',
    );
  }
  if (done.claude) lines.push('Claude Code loads it through CLAUDE.md, so a session starts with it instead of rediscovering the repository.');
  if (done.hook) {
    lines.push(
      'Every commit on this machine is checked before it lands: secret-shaped lines, files outside NASO_SCOPE, ' +
        'format and lint on staged files, and a briefing line for any new top-level area.',
    );
    lines.push(`The gate runs from ${NASO_DIR}/tooling/ with no network and no package install.`);
  } else {
    lines.push(`No pre-commit gate. Run it by hand: node ${NASO_DIR}/tooling/validate.mjs --staged`);
  }
  // Every block carries the Decisions section, so this holds whatever else the run skipped.
  lines.push(
    `Decisions survive the session: AGENTS.md tells every agent to read ${indexFileOf(state?.facts?.decisions?.dir ?? 'docs/decisions')} before proposing an approach, ` +
      `and to record what you decide with \`${nasoCommand()} decide\`.`,
  );
  if (done.dev) lines.push('naso-dev is in devDependencies: teammates get this version from an ordinary install, and production installs leave it out.');
  lines.push(
    track
      ? `Commit AGENTS.md and ${NASO_DIR}/ and every teammate gets the same briefing and the same gate (the hook itself is per machine).`
      : `Nothing reached git history: AGENTS.md and ${NASO_DIR}/ stay on this machine until you choose --track.`,
  );
  return lines;
}

/**
 * The script entry, kept for `node .naso/tooling/setup.mjs` and older scripts.
 *
 * It plans, and writes only on --yes. The questions, the accept / reject loop and the
 * support offer live in the `npx naso-dev` flow, which can draw a prompt; this file is
 * vendored and must run with no node_modules, so it asks nothing.
 */
export async function main(argv = process.argv.slice(2)) {
  const { flags, values, lists, positional } = parseArgs(argv);

  if (flags.has('help')) {
    console.log(`NASO setup

Usage:
  node ${NASO_DIR}/tooling/setup.mjs [target-dir] [options]

  --track              commit ${NASO_DIR}/ and AGENTS.md instead of excluding them locally
  --no-hook            do not install the pre-commit hook
  --hook-action <a>    install | chain | skip | abort, for a hook NASO did not write
  --save-dev           record naso-dev in devDependencies with the package manager
  --exclude <prefix>   keep an area out of the briefing; repeatable, saved to config.json
  --force              replace an existing naso:start / naso:end block, and nothing else
  --yes                accept the plan and write it
  --dry-run            print the plan and stop

Without --yes this prints the plan and writes nothing. To answer the questions and
accept or reject interactively, run \`${nasoCommand()}\`.

Support: ${SUPPORT_EMAIL}`);
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
    discardEdits: flags.has('discard-edits'),
  };

  if (!(await pathExists(cwd))) {
    console.error(`naso-dev setup: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const state = await inspect(cwd, options);
  await displayPlan(state, cwd);

  if (options.dryRun) {
    console.log('--dry-run: nothing was written.');
    return;
  }
  if (state.hookDecision.action === 'abort') {
    console.log('--hook-action abort: nothing was written.');
    return;
  }
  if (options.yes) {
    console.log('--yes: accepting the plan above.');
    console.log('');
    const ok = await install(cwd, { ...options, state });
    if (!ok) process.exitCode = 1;
    return;
  }

  console.log('## Not written');
  console.log('');
  console.log('  This script asks nothing. Pass --yes to write the plan above, --dry-run to');
  console.log(`  only print it, or run \`${nasoCommand()}\` to accept or reject it interactively.`);
  console.log('');
  process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`naso-dev setup: unexpected error — ${err?.stack ?? err}`);
    console.error(`Support: ${SUPPORT_EMAIL}`);
    process.exitCode = 1;
  });
}
