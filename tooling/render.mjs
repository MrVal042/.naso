// NASO render — turn the scan's facts into the AGENTS.md block. Every sentence is a
// count, a config value or a path the scan read; a section with nothing to say is left out.
//
// Zero external dependencies — Node.js core modules only.

import {
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  run,
  pmRunText,
  section,
} from './lib.mjs';
import {
  AUTO_END,
  AUTO_START,
  CREDENTIAL_PATTERN,
  HISTORY_MINIMUM,
  NASO_END,
  NASO_START,
  SCRIPT_DELEGATES_TO,
  TEMPLATE_HEADER,
  languageMix,
  readIgnorePatterns,
  readLocalExcludes,
  roleFor,
  plural,
} from './scan.mjs';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const humanize = (key) =>
  key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());


/**
 * The first few of a list, and a count of the rest.
 *
 * A warning's paths land in AGENTS.md, which an agent reads at the start of every session.
 * All 155 of a monorepo's test files cost thousands of tokens there and say nothing the
 * count and five examples do not; `paths` on the warning still carries the full list.
 */
export function someOf(items, shown = 5) {
  if (items.length <= shown) return items.join(', ');
  return `${items.slice(0, shown).join(', ')}, and ${items.length - shown} more`;
}

/**
 * The findings the briefing and the setup screen both have to say out loud.
 *
 * Two rules keep this list honest. A warning names paths that exist — no speculative
 * "check your .env" — and each one says what to do about it rather than only what it found.
 * `where` decides who says it: `briefing` findings are facts about the repository and go
 * into AGENTS.md, where an agent working alone will read them; `setup` findings are worth
 * a person's attention once and have no business being frozen into a file.
 */
export async function scanWarnings(facts) {
  const warnings = [];

  const tests = facts.tests;
  if (tests && tests.missed.length > 0) {
    warnings.push({
      id: 'tests-not-run',
      where: 'briefing',
      headline:
        `\`${tests.command}\` runs ${tests.targets.map((t) => `\`${t}\``).join(', ')}, ` +
        `and ${plural(tests.missed.length, 'tracked test file')} ${tests.missed.length === 1 ? 'is' : 'are'} outside it`,
      detail: someOf(tests.missed),
      paths: tests.missed,
    });
  }

  warnings.push(...(await detectVersionContradictions(facts)));
  warnings.push(...trackedSecretWarnings(facts));
  warnings.push(...trackedJunkWarnings(facts));

  return warnings;
}

/** Every Node version this repository declares, and where it was declared. */
async function declaredNodeVersions(facts) {
  const declared = [];
  const majorsOf = (text) =>
    [...String(text).matchAll(/\d+/g)].map((match) => Number(match[0])).filter((n) => n >= 10 && n < 100);

  const engines = facts.pkg?.engines?.node ?? facts.pkg?.volta?.node;
  if (typeof engines === 'string') declared.push({ source: 'package.json engines.node', value: engines, majors: majorsOf(engines) });

  const nvmrc = await readFile(path.join(facts.cwd, '.nvmrc'), 'utf8').catch(() => null);
  if (nvmrc !== null && nvmrc.trim()) declared.push({ source: '.nvmrc', value: nvmrc.trim(), majors: majorsOf(nvmrc) });

  for (const file of ['.github/workflows/ci.yml', '.github/workflows/ci.yaml']) {
    const text = await readFile(path.join(facts.cwd, file), 'utf8').catch(() => null);
    if (text === null) continue;
    for (const match of text.matchAll(/node[-_]version\s*:\s*(.+)/g)) {
      declared.push({ source: `${file} node-version`, value: match[1].trim(), majors: majorsOf(match[1]) });
    }
  }

  return declared.filter((entry) => entry.majors.length > 0);
}

/**
 * README against package.json, .nvmrc and CI.
 *
 * These are four places the same fact is written, and nothing keeps them in step: a
 * contributor reads "requires Node >= 18" in the README, the CI matrix runs 20, and the
 * bug they file afterwards is "works on my machine" with a cause nobody wrote down. The
 * check is a set intersection on major versions, which is loose on purpose — it fires on
 * 18-versus-20 and stays quiet about the patch level.
 */
async function detectVersionContradictions(facts) {
  const readme = facts.files.find((file) => /^readme(\.md|\.rst|\.txt)?$/i.test(file));
  if (!readme) return [];

  const text = await readFile(path.join(facts.cwd, readme), 'utf8').catch(() => null);
  if (text === null) return [];

  const claimed = new Set();
  for (const match of text.matchAll(/node(?:\.?js)?\s*(?:version\s*)?(?:[>=^~]+\s*)?(\d+)(?:\.(\d+))?/gi)) {
    const major = Number(match[1]);
    if (major >= 10 && major < 100) claimed.add(major);
  }
  if (claimed.size === 0) return [];

  const declared = await declaredNodeVersions(facts);
  if (declared.length === 0) return [];

  const contradicting = declared.filter((entry) => !entry.majors.some((major) => claimed.has(major)));
  if (contradicting.length === 0) return [];

  return [
    {
      id: 'node-version-contradiction',
      where: 'setup',
      headline: `${readme} and the declared Node version disagree`,
      detail:
        `README claims Node ${[...claimed].sort((a, b) => a - b).join(', ')}; ` +
        `${contradicting.map((entry) => `${entry.source} says ${entry.value}`).join('; ')}`,
      paths: [readme, ...contradicting.map((entry) => entry.source)],
    },
  ];
}

/**
 * Credential-shaped files that are in the index.
 *
 * Path only, and that is the whole discipline: a warning that quoted the file would put
 * the secret in the terminal scrollback, in a support request, and in whatever the reader
 * pastes it into. A file matching an ignore pattern and tracked anyway was normally added
 * before the pattern existed or with `git add -f`, and it will not show up in a later
 * `git status` — which is why it is worth saying out loud at all.
 */
function trackedSecretWarnings(facts) {
  const secrets = facts.files.filter((file) => CREDENTIAL_PATTERN.test(file));
  if (secrets.length === 0) return [];

  const ignored = facts.ignoredPatterns?.credentials ?? [];
  const alsoIgnored = ignored.length > 0;

  return [
    {
      id: 'tracked-secret',
      where: 'setup',
      headline: `${plural(secrets.length, 'credential-shaped file')} ${secrets.length === 1 ? 'is' : 'are'} tracked in git`,
      detail:
        `${someOf(secrets)} — path only, contents not read.` +
        (alsoIgnored
          ? ` ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} in .gitignore, so ${secrets.length === 1 ? 'this file is' : 'these files are'} tracked from before the rule or added with -f, and will not appear in git status.`
          : ' Nothing in .gitignore covers them, so a new one will be added by accident.'),
      paths: secrets,
    },
  ];
}

/** Root files that declare a Python project's dependencies, and the lockfile that names its tool. */
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'];
const PYTHON_LOCKS = [
  ['uv.lock', 'uv'],
  ['poetry.lock', 'Poetry'],
  ['Pipfile.lock', 'Pipenv'],
];

/** The Python dependency line, from root files that exist; null when there are none. */
function pythonDependencies(files) {
  const declared = PYTHON_MANIFESTS.filter((name) => files.includes(name));
  if (declared.length === 0) return null;
  const lock = PYTHON_LOCKS.find(([name]) => files.includes(name));
  return (
    `Python dependencies: ${declared.map((name) => `\`${name}\``).join(', ')}` +
    (lock ? `, locked by \`${lock[0]}\` (${lock[1]}).` : '.')
  );
}

/**
 * Files a machine or a running program writes, which are almost never meant to be shared.
 *
 * A local database is listed as "usually": some projects commit a seed on purpose, and the
 * warning says what it found rather than what to delete.
 */
const JUNK_FILE =
  /(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|npm-debug\.log[^/]*)$|(?:^|\/)__pycache__\/|\.py[co]$|\.(?:db|sqlite3?)$/i;

function trackedJunkWarnings(facts) {
  const junk = facts.files.filter((file) => JUNK_FILE.test(file));
  if (junk.length === 0) return [];
  return [
    {
      id: 'tracked-junk',
      where: 'setup',
      headline: `${plural(junk.length, 'machine or runtime file')} ${junk.length === 1 ? 'is' : 'are'} tracked in git`,
      detail:
        `${someOf(junk)} — OS metadata, bytecode or a local database, usually written by a machine ` +
        'rather than a person. If none is meant to be shared, `git rm --cached` it and add it to .gitignore.',
      paths: junk,
    },
  ];
}

/** The tests line, naming the runner and what the script actually runs. */
function renderTests(facts) {
  const { conventions, tests } = facts;
  const parts = [];

  if (tests?.runner) parts.push(`runner ${tests.runner}`);

  const count = plural(tests?.total ?? conventions.testFiles, 'test file');
  const roots = (conventions.separateRoots ?? []).map((r) => `\`${r}/\``).join(', ');
  if (conventions.colocated) {
    parts.push(`${count} co-located with the source they test`);
  } else if (conventions.colocatedCount > 0 && conventions.separateCount > 0) {
    parts.push(`${count} (${conventions.colocatedCount} co-located with source, ${conventions.separateCount} under ${roots})`);
  } else if (conventions.testRoots.length > 0) {
    parts.push(`${count} (under ${conventions.testRoots.map((r) => `\`${r}/\``).join(', ')})`);
  } else {
    parts.push(count);
  }

  // What the script runs comes last, because it is the claim that has to be weighed
  // against the count: a count of two and a target of one directory is the gap the
  // warning below spells out.
  if (tests?.command && tests.targets.length > 0) {
    parts.push(`run by \`${tests.command}\` as ${tests.targets.map((t) => `\`${t}\``).join(', ')}`);
  } else if (tests?.command && tests?.openEnded) {
    parts.push(`\`${tests.command}\` names no path, so it discovers its own inputs`);
  }

  return `${parts.join(', ')}.`;
}

/**
 * "61 files, 2 of them Kotlin" — the size of an area, and the language that
 * actually appears in it.
 *
 * Deliberately counts *code* files separately from total files rather than
 * rounding to a percentage. `android/` in a React Native project is 2 Kotlin
 * files and 59 resources; "mostly Kotlin (3%)" would be arithmetic dressed up as
 * a description, and "all 2 files are Kotlin" would be a lie about 61.
 */
function fileCountSentence(entry) {
  const total = entry.files.length;
  const language = entry.language;

  if (!language || language.total === 0) return plural(total, 'file');
  if (language.total === total) {
    return total === 1 ? `1 file, ${language.label}` : `all ${plural(total, 'file')} are ${language.label}`;
  }
  return `${plural(total, 'file')}, ${language.total} of them ${language.label}`;
}

/**
 * One line per area: what it is, how big it is, and how to get in.
 *
 * The counts and the entry point are what make the line worth keeping — they go
 * stale visibly, whereas "this is where the app lives" does not. When neither the
 * name nor a manifest says what the area is for, the line says so rather than
 * guessing, because a wrong purpose is the one error an agent cannot detect on
 * its own and will confidently build on.
 */
export function describeEntry(entry) {
  const label = entry.isDir ? `${entry.name}/` : entry.name;
  const role = entry.role ?? roleFor(entry.name);

  const facts = [fileCountSentence(entry)];
  if (entry.testFiles > 0) facts.push(`${plural(entry.testFiles, 'test file')}`);
  if (entry.manifest) facts.push(`manifest \`${entry.isDir ? `${entry.name}/` : ''}${entry.manifest}\``);
  if (entry.entryPoint) facts.push(`entry \`${entry.entryPoint}\``);

  const responsibility = role ?? 'role not derivable from its name or a manifest';
  return `- \`${label}\` — ${responsibility}; ${facts.join('; ')}.`;
}

/** Root files as one wrapped list rather than a dozen one-line entries. */
export function renderRootFiles(entries, facts = null) {
  const roots = entries.filter((entry) => !entry.isDir);
  if (roots.length === 0) return null;

  const names = roots.map((entry) => `\`${entry.name}\``).join(', ');
  const withEntries = roots
    .filter((entry) => entry.entryPoint)
    .map((entry) => `\`${entry.name}\``)
    .join(', ');

  const manifestEntry = facts.manifestEntryPoints[0] ?? null;

  if (manifestEntry && entries.some((entry) => entry.entryPoint === manifestEntry.value)) {
    // package.json names the entry point; that is a fact. A file called index.js is a guess.
    return (
      `Root files, none of which is an area of its own: ${names}.\n` +
      `The entry point is \`${manifestEntry.value}\` — package.json "${manifestEntry.field}".`
    );
  }

  return (
    `Root files, none of which is an area of its own: ${names}.` +
    (withEntries
      ? `\n${facts?.pkg ? 'package.json declares no entry point' : 'No manifest declares an entry point'}; ${withEntries} ${roots.filter((e) => e.entryPoint).length === 1 ? 'is' + ' named for one' : 'are named like one'}, which is a filename guess.`
      : '')
  );
}

/**
 * Name-based wording for a unit the scanner could not describe.
 *
 * Reached only when the unit is absent from the scan — a directory with no files
 * yet, or one git does not list. A name-based noun beats silence: a briefing
 * that quietly stops describing the repository is worse than a slightly wrong
 * noun somebody corrects in one edit.
 */
export function describeUnit(unit) {
  const isDir = unit.endsWith('/');
  const name = isDir ? unit.slice(0, -1) : unit;

  if (/^(readme|changelog|contributing|license|licence|notice)$/i.test(name)) {
    return 'project documentation';
  }
  if (/^(docs?|documentation)$/i.test(name)) return 'documentation';
  if (/^(test|tests|__tests__|spec|specs|e2e|cypress|fixtures?)$/i.test(name)) return 'tests';
  if (/^(src|lib|app|apps|pkg|packages|internal|cmd|source)$/i.test(name)) {
    return 'application source';
  }
  if (/^(scripts?|tools?|bin|tooling)$/i.test(name)) return 'developer scripts';
  if (/^(infra|infrastructure|deploy|deployment|terraform|helm|k8s|docker)$/i.test(name)) {
    return 'infrastructure';
  }
  if (/^(config|configs|ci)$/i.test(name)) return 'configuration';
  if (/^(migrations?|db|database|schema|seed|seeds)$/i.test(name)) return 'data layer';
  if (isDir) return 'a new top-level area';
  return 'a new top-level file';
}

/**
 * The briefing line for one unit, described from a scan when one is available.
 *
 * Shared by generation and by the pre-commit append, so an area added by a commit
 * is written to the same standard as the rest of the file — and, critically, with
 * no marker for a human to come back and fill. That was the exact failure mode
 * 2.x had: a briefing that can only be finished by hand never gets finished.
 */
export function lineForUnit(unit, facts) {
  const isDir = unit.endsWith('/');
  const name = isDir ? unit.slice(0, -1) : unit;
  const entry = facts?.entries?.find((candidate) => candidate.name === name);

  if (entry) return describeEntry(entry);
  return `- \`${unit}\` — ${describeUnit(unit)}; new in this commit.`;
}

/** A doc that describes where code lives, named the way such docs usually are. */
const LAYOUT_DOC = /^docs?\/(?:architecture|folder-structure|folders|structure|layout|overview|codebase)\.md$/i;

/** Paths a new agent should open first, all verified to exist. */
function renderLookFirst(facts) {
  const lines = [];
  const seen = new Set();

  const push = (entryPath, why) => {
    if (!entryPath || seen.has(entryPath)) return;
    if (!facts.files.includes(entryPath)) return;
    seen.add(entryPath);
    lines.push(`- \`${entryPath}\` — ${why}`);
  };

  for (const { field, value } of facts.manifestEntryPoints) {
    push(value, `package.json "${field}" — what the project publishes or runs`);
  }

  push('README.md', 'the project in its own words; check it before assuming anything below');
  push('CONTRIBUTING.md', 'how this project expects changes to be made; it outranks this file');
  for (const doc of facts.files.filter((file) => LAYOUT_DOC.test(file)).slice(0, 2)) {
    push(doc, 'the map of the code in the project\'s own words');
  }
  push('package.json', 'scripts, dependencies and the runtime the project declares');

  for (const entry of facts.entries.filter((e) => !e.isDir && e.entryPoint)) {
    push(entry.name, 'entry point declared by its own filename');
  }

  const testRoot = facts.entries.find((entry) => entry.testFiles > 0);
  if (testRoot) {
    const testPath = testRoot.isDir ? `${testRoot.name}/` : testRoot.name;
    push(testPath, `${plural(testRoot.testFiles, 'test file')} — the executable description of expected behaviour`);
  }

  if (lines.length === 0) return null;
  return lines;
}

function renderConventions(facts) {
  const { conventions, packageManager } = facts;
  const lines = [];

  // AGENTS.md is left out here as it is everywhere else the header says it is, and the
  // total is every file with an extension: summing only the four shown made a number
  // nobody could reproduce.
  const all = languageMix(facts.files.filter((file) => file !== 'AGENTS.md'));
  const mix = all.slice(0, 4);
  if (mix.length > 0) {
    const total = all.reduce((sum, item) => sum + item.count, 0);
    lines.push(
      `Language mix: ${mix.map((item) => `${item.label} ${item.count}`).join(', ')}` +
        ` (of ${total} files with an extension).`,
    );
  }

  // A repository with no package.json has no Node package manager, and naming npm there
  // ("from no package.json, no lockfile") told a Python project every command used npm.
  if (packageManager && packageManager.source !== 'none') {
    // Said once, here, because every command further down depends on it and a reader who
    // pastes `npm run verify` into a pnpm repository gets a lockfile nobody asked for.
    lines.push(
      `Package manager: ${packageManager.name} (from ${packageManager.evidence}). ` +
        'Every command in this file uses it.',
    );
  }

  const python = pythonDependencies(facts.files);
  if (python) lines.push(python);

  if (conventions.moduleSystem) lines.push(`Modules: ${conventions.moduleSystem}.`);

  if (conventions.typescript) {
    const parts = [`TypeScript ${conventions.typescript.version.replace(/^[\^~]/, '')}`];
    parts.push(conventions.typescript.hasTsconfig ? 'tsconfig.json present' : 'no tsconfig.json');
    if (conventions.typescript.hasTsconfig) {
      parts.push(conventions.typescript.strict ? '"strict": true' : '"strict" is not set');
    }
    lines.push(`${parts.join(', ')}.`);
  }

  if (conventions.runner || conventions.testFiles > 0 || facts.tests?.total > 0) {
    lines.push(`Tests: ${renderTests(facts)}`);
  }

  if (conventions.eslintConfig) lines.push(`Lint: ESLint configured by \`${conventions.eslintConfig}\`.`);
  if (conventions.prettierConfig) {
    lines.push(`Format: Prettier configured by \`${conventions.prettierConfig}\`.`);
  }

  const aliases = conventions.aliases?.declared ?? [];
  if (aliases.length > 0) {
    // Rendered without backticks on the target: an alias target like "." or "src"
    // is a pattern, not a claim that the file "." exists, and the checker would
    // correctly report it as MISSING.
    const rendered = aliases.map((entry) => {
      const where = entry.files
        .map((file) => (entry.spellings?.[file] && entry.spellings[file] !== entry.alias ? `${file} as ${entry.spellings[file]}` : file))
        .join(', ');
      const gap =
        entry.absent.length > 0 ? ` — ${entry.absent.join(', ')} does not declare it` : '';
      return `${entry.alias} → ${entry.targets.join(', ')} (${where}${gap})`;
    });
    lines.push(`Import aliases: ${rendered.join('; ')}.`);

    if (conventions.aliases.files.length > 1) {
      lines.push(
        `Aliases are declared in ${plural(conventions.aliases.files.length, 'file')} ` +
          `(${conventions.aliases.files.join(', ')}), so a new one must be added to all ` +
          'of them: an alias one toolchain knows and another does not builds in Metro and ' +
          'fails in tsc, with neither tool naming the cause.',
      );
    }
  }

  if (conventions.mixedFolders.length > 0) {
    lines.push(
      `Not one module system throughout: ${conventions.mixedFolders
        .map((folder) => `\`${folder.folder}\` is ${folder.kind} (${folder.evidence})`)
        .join('; ')}.`,
    );
  }

  if (lines.length === 0) return null;
  return lines;
}


/**
 * The boundaries this repository actually enforces, and the docs that say what they mean.
 *
 * A `verify:boundary:*` script is a boundary somebody wrote a rule for, and the rule is
 * almost never in the script: it is in the doc the script points at. Both are read, so the
 * section can say "auth cannot import from the payments folder, per docs/boundaries/auth.md"
 * instead of naming a script and leaving the reader to go find the rule.
 */
export async function detectEnforcedBoundaries(facts) {
  const scripts = facts.pkg?.scripts ?? {};
  // Every `verify:*` script, and anything named for a boundary, whatever its prefix — then
  // every `verify:*` step the gate runs that the manifest does not declare. Matching on the
  // word "boundary" alone missed `verify:boundaries` and every check named for what it
  // checks instead (`verify:licenses`), which is most of them.
  const gateSteps = facts.gate?.rawSteps ?? [];
  const names = [
    ...new Set([
      ...Object.keys(scripts).filter((name) => /^verify:/.test(name) || /boundar/i.test(name)),
      ...gateSteps.filter((step) => /^verify:/.test(step)),
    ]),
  ];
  const boundaries = [];

  for (const name of names) {
    const body = scripts[name];
    const file = body?.match(SCRIPT_DELEGATES_TO)?.[1]?.replace(/^\.\//, '') ?? null;
    const docs = [];

    if (file) {
      const text = await readFile(path.join(facts.cwd, file), 'utf8').catch(() => null);
      if (text !== null) {
        // A doc reference is read as a plain path token, not a backticked one: a script
        // says where the rule lives in a comment or a string, and requiring backticks
        // would miss most of them. Only tracked markdown counts — a path that is not in
        // the index is a stale reference, and sending a reader there wastes their turn.
        for (const token of text.matchAll(/[\w./@-]*[\w-]+\.md\b/g)) {
          const doc = token[0].replace(/^\.\//, '');
          if (!facts.files.includes(doc)) continue;
          if (!docs.includes(doc)) docs.push(doc);
        }
      }
    }

    boundaries.push({
      name,
      command: pmRunText(facts.packageManager?.name ?? 'npm', name),
      file,
      fileExists: Boolean(file) && facts.files.includes(file),
      // Only a gate NASO actually read can vouch for membership.
      inGate: Boolean(facts.gate?.parsed && gateSteps.includes(name)),
      hasGate: Boolean(facts.gate?.command),
      docs,
    });
  }

  return boundaries;
}

/**
 * The lines people cross by accident, stated as facts about this repository.
 *
 * Ordered by what an agent is most likely to get wrong, not by what the tooling happens to
 * know: the enforced boundaries first, because they are this repository's own rules and the
 * only thing here that can fail a commit; then the aliases, because an import that resolves
 * in one toolchain is the quietest failure there is; then the ignore rules, which are the
 * broadest and therefore the least surprising.
 *
 * Credential-shaped patterns are never abbreviated away. A `.gitignore` with forty entries
 * is a briefing sentence; one that silently drops `*.keystore` while listing `node_modules/`
 * is a lie about the repository's worst habit.
 */
async function renderBoundaries(facts) {
  const lines = [];
  const { conventions } = facts;

  const boundaries = await detectEnforcedBoundaries(facts);
  if (boundaries.length > 0) {
    // An unread gate makes membership unknown. Reporting every boundary script as
    // "not shown to run in the gate" in that case is a claim NASO cannot support:
    // the gate may well run all of them, and the section is read as an audit rather
    // than as a guess. It is the same reason an unparsed gate never claims a step
    // list.
    const gateUnknown = Boolean(facts.gate) && facts.gate.parsed === false;

    lines.push(
      `**Enforced checks.** ${plural(boundaries.length, 'verify or boundary script')} this repository ` +
        'declares or its gate runs, each with whether the gate runs it:',
    );
    if (gateUnknown) {
      lines.push(
        `The gate could not be read (${facts.gate.unparsed ?? 'the script it delegates to'}), ` +
          'so whether it runs these scripts is unknown. Read it before trusting a commit to be checked.',
      );
    }
    for (const boundary of boundaries) {
      const gate = gateUnknown
        ? 'gate membership unknown'
        : boundary.inGate
          ? 'runs in the gate'
          : boundary.hasGate
            ? 'not run by the gate'
            : 'no gate in this repository runs it';
      const target = boundary.file
        ? boundary.fileExists
          ? `checks \`${boundary.file}\``
          : // Not backticked: the briefing is reporting a broken reference, and a backticked
            // path here would read as a claim that the file exists — which the checker would
            // then correctly contradict.
            `names ${boundary.file}, which is not in the index`
        : 'could not be resolved to a file';
      const docs = boundary.docs.length > 0 ? `; the rule is in ${boundary.docs.map((d) => `\`${d}\``).join(', ')}` : '';
      lines.push(`- \`${boundary.name}\` (\`${boundary.command}\`) — ${target}, ${gate}${docs}.`);
    }
  }

  // Before the aliases: editing a generated file is a mistake that survives review and
  // is undone, silently, by the next regenerate.
  const generated = facts.generated ?? [];
  if (generated.length > 0) {
    const guarded = new Set((facts.gate?.jobs ?? []).flatMap((job) => job.diffChecks ?? []));
    lines.push(
      `**Generated files.** ${generated
        .map(
          (entry) =>
            `\`${entry.path}\` is written by \`${entry.command}\`; regenerate it, never edit it by hand.` +
            (guarded.has(entry.path) ? ' CI fails if it changes.' : ''),
        )
        .join(' ')}`,
    );
  }

  const declared = conventions.aliases?.declared ?? [];
  if (declared.length > 0) {
    lines.push(
      // The mapping only. Whether this repository prefers the alias over a relative path is
      // a rule in its docs or its lint config, and NASO reads neither; "a relative import is
      // the one mistake TypeScript will not catch" was a rule nobody here had written.
      `**Import aliases.** ${declared.map((entry) => `${entry.alias} → ${entry.targets.join(', ')}`).join('; ')}.`,
    );
    if (conventions.aliases.files.length > 1) {
      const missing = conventions.aliases.divergent;
      lines.push(
        `Declared in ${conventions.aliases.files.join(', ')}. A new alias must go in all of ` +
          'them, or it resolves in one toolchain and not the other.' +
          (missing.length > 0
            ? ` Already divergent: ${missing.map((entry) => `${entry.alias} (missing from ${entry.absent.join(', ')})`).join('; ')}.`
            : ''),
      );
    }
  }

  if (Array.isArray(conventions.eslintIgnores) && conventions.eslintIgnores.length > 0) {
    // Not backticked: these are glob patterns, not paths that must exist.
    lines.push(
      `**Lint.** ESLint ignores ${conventions.eslintIgnores.join(', ')} — lint passes there ` +
        'because nothing is checked, not because the code is correct.',
    );
  }

  const ignored = await readIgnorePatterns(facts.cwd);
  if (ignored) {
    if (ignored.credentials.length > 0) {
      lines.push(
        `**Credentials.** .gitignore excludes ${ignored.credentials.join(', ')}. A file matching ` +
          'one of these is never committed, which means a real key there is invisible to ' +
          '`git status` — look for it before assuming a build failure is unrelated.',
      );
    }

    // Root-anchored first: `/ios` is this repository's own decision, `node_modules/` is
    // everybody's, and the cap below hid the former behind the latter.
    const ordered = [...ignored.ordinary.filter((p) => p.startsWith('/')), ...ignored.ordinary.filter((p) => !p.startsWith('/'))];
    const shown = ordered.slice(0, 10);
    const elided = ordered.length - shown.length;
    if (shown.length > 0) {
      lines.push(
        `**Ignored paths.** Nothing under ${shown.join(', ')} reaches a commit, and nothing ` +
          `under ${shown.length === 1 ? 'it is' : 'them is'} reviewed.` +
          (elided > 0 ? ` ${elided} further pattern${elided === 1 ? '' : 's'} in .gitignore ${elided === 1 ? 'is' : 'are'} not listed here.` : ''),
      );
    }

    if (ignored.negated.length > 0) {
      lines.push(
        `**Re-included.** ${ignored.negated.join(', ')} — a negated pattern means those paths ` +
          'are tracked after all, whatever sits above them.',
      );
    }
  }

  const local = [...new Set([...(await readLocalExcludes(facts.cwd)), ...(facts.pendingLocalExcludes ?? [])])];
  if (local.length > 0) {
    lines.push(
      `**Local excludes.** .git/info/exclude holds ${local.join(', ')} on this machine only. ` +
        'Nobody else has them: a teammate cloning this repository gets none of these paths ' +
        'excluded, so do not reason about them as if they were shared policy.',
    );
  }

  if (lines.length === 0) return null;
  return lines;
}

/**
 * The commit rules this repository's history and NASO's hook can stand behind.
 *
 * Only two kinds of line: what the last commits show, and what the hook enforces. A
 * generic rule ("inventory first", "the body explains why") costs every session the
 * same tokens and tells an agent nothing about this repository.
 */
function renderCommitStandard(facts) {
  const history = facts.history ?? { count: 0 };
  const lines = [];

  if (facts.contributing?.commits) {
    lines.push(`- \`${facts.contributing.path}\` writes the commit rules down; where it and this count differ, it wins.`);
  }

  if (history.count >= HISTORY_MINIMUM && history.conventional / history.count >= 0.6) {
    lines.push(
      `- Subjects follow \`${subjectShape(history)}\` in ${history.conventional} of the last ` +
        `${history.count} non-merge commits. Types used: ${history.types.join(', ')}.`,
    );
    // A scope used now and then is allowed, not expected. Saying `type(scope)` for a
    // history that almost never has one taught agents to invent scopes.
    if (history.scoped > 0 && history.scoped / history.conventional < 0.6) {
      lines.push(`  ${history.scoped} of them add a scope: \`type(scope): …\`.`);
    }
  }
  if (history.count >= HISTORY_MINIMUM && history.coAuthored === 0) {
    lines.push(
      `- No commit in the last ${history.count} carries a \`Co-Authored-By:\` trailer; do not ` +
        'add one for the assisting agent or tool.',
    );
  }
  lines.push('- Do not bypass the pre-commit hook. Fix what it reports and commit again.');
  lines.push(`- ${commitStandardRule8(facts).replace(/^8\. /, '').replace(/\n {3}/g, '\n  ')}`);
  return lines;
}

/** The subject form most of the history uses: scope and ticket key only when most have one. */
function subjectShape(history) {
  const most = (n) => n / history.conventional >= 0.6;
  const head = most(history.scoped) ? 'type(scope)' : 'type';
  const ticket = most(history.ticketed) && history.ticketKey ? `${history.ticketKey}-n: ` : '';
  return `${head}: ${ticket}summary`;
}

/** The closing note, naming the commands this repository declares; null when it names none. */
function renderWhenDone(facts) {
  const commands = facts.gate?.command
    ? [facts.gate.command]
    : facts.gate?.ciFile
      ? ciCommands(facts.gate)
      : facts.validation.map((command) => command.command);
  if (commands.length === 0) return null;
  return (
    `Say which of ${commands.map((command) => `\`${command}\``).join(', ')} ran and what it ` +
    'printed, which files changed, and what is left uncommitted.'
  );
}

/**
 * Rule 8, which depends on whether this file is in the index.
 *
 * The old wording told every reader to stage the line the hook appends, in a repository
 * where the default run leaves AGENTS.md out of git entirely — so it described a commit
 * that could not be made, and invited an agent to `git add -f` a file the user chose to
 * keep local. Two different situations, two different rules, chosen from the index rather
 * than from a flag: tracked means the briefing is reviewed like any other file and the
 * appended line belongs in the commit; untracked means it never is.
 */
function commitStandardRule8(facts) {
  if (facts.agentsTracked) {
    return (
      '8. When a commit adds a genuinely new area, the hook appends one line for it\n' +
      '   above and stages it with the commit. This file is tracked, so it is reviewed\n' +
      '   like any other: if the hook reports it unstaged, that is a finding to fix.'
    );
  }

  return (
    '8. This file is not in the index and never will be: it is local to this machine,\n' +
    '   excluded through .git/info/exclude so setup leaves no trace in the history. Do\n' +
    '   not stage it, do not `git add -f` it, and do not mention it in a commit message.\n' +
    '   The line the hook appends for a new area stays unstaged and is reported; every\n' +
    "   teammate's briefing is generated from their own scan of their own checkout."
  );
}

/**
 * Render the whole briefing.
 *
 * Sections that derive nothing are omitted rather than left as an invitation to
 * fill them in later — an empty heading reads as a section someone forgot, and
 * an agent that trusts the file will waste a turn looking for content that is
 * not coming.
 */
/**
 * How the counts in this file were arrived at, stated once, at the top.
 *
 * A count without its provenance is the failure this whole tool exists to prevent, so the
 * header says which list it came from rather than leaving it to be assumed. In a git
 * repository that is the index, so nothing in an ignored build directory can be in it; on a
 * directory git does not manage it is a filesystem walk, which is a weaker claim, and the
 * reader is told so instead of being handed a number that quietly includes node_modules.
 */
export function countPhrase(facts) {
  return facts.fileSource === 'git'
    ? plural(facts.trackedCount, 'tracked file')
    : `${plural(facts.trackedCount, 'file')} on disk`;
}

export function countProvenance(facts) {
  return facts.fileSource === 'git'
    ? `${plural(facts.trackedCount, 'tracked file')}, excluding AGENTS.md`
    : `${plural(facts.trackedCount, 'file')} on disk - this directory is not a git repository, ` +
        'so these counts come from a filesystem walk and include anything in ignored build output';
}

/**
 * The validation section: one gate and what it subsumes.
 *
 * The previous version listed `lint`, `typecheck`, `test` and `verify` as four peers, which
 * is wrong in a way that costs real time — on a repository where `verify` runs the first
 * three, an agent following the list runs the whole suite twice and has no idea which
 * single command the project considers the answer.
 *
 * So: the gate is named once, what it subsumes is listed as prose under it, and the
 * scripts it demonstrably runs are never repeated as peers. Only commands the gate does
 * *not* cover get their own line, because those are the ones that still have to be run by
 * hand and the briefing is the only place that can say so.
 *
 * When there is no gate at all — no workflow job, no verify/check/ci script — the section
 * degrades to the plain list. Inventing an authoritative command for a repository that
 * never named one is the failure this tool exists to prevent.
 */
export function renderValidation(facts) {
  const { gate, validation } = facts;
  const rewriters = rewriterNote(facts);

  if (gate?.ciFile && !gate.command) return renderCiGate(facts, rewriters);

  if (!gate || !gate.command) {
    if (validation.length === 0) return rewriters ? `### Validation commands\n\n${rewriters}` : null;
    return (
      `### Validation commands\n\nThis repository names no single gate. These are the ` +
      `commands it declares:\n\n\`\`\`bash\n${validation.map((c) => c.command).join('\n')}\n\`\`\`` +
      (rewriters ? `\n\n${rewriters}` : '')
    );
  }

  const lines = [`### Validation commands\n`];
  lines.push(`One gate: \`${gate.command}\` — the authority is ${gate.authority}.`);

  if (gate.unparsed) {
    lines.push(
      `**WARN** The gate could not be parsed; see \`${gate.unparsed}\`. Read it before ` +
        'trusting what this file says the gate covers — NASO will not guess.',
    );
  } else if (gate.steps.length > 0) {
    const from = gate.stepFile ? `read from \`${gate.stepFile}\`` : 'read from the script body';
    lines.push(`It runs, in order (${from}): ${gate.steps.join(', ')}.`);
  }

  if (gate.managerMismatch) {
    lines.push(
      `**WARN** The gate invokes ${gate.managersUsed.join(', ')} internally while this ` +
        'repository installs with a different manager, so it may resolve binaries it did ' +
        'not install. Run it and read what it prints.',
    );
  }

  if (gate.enforcement.length > 0) {
    lines.push(
      `Checks this repository names: ${gate.enforcement
        .map((entry) => `\`${entry.name}\` — ${entry.inGate ? 'in the gate' : 'no sign it is in the gate'}`)
        .join('; ')}.`,
    );
  }

  const covered = new Set(gate.rawSteps ?? []);
  const others = validation.filter(
    (command) => command.script !== gate.script && !covered.has(command.script),
  );
  if (others.length > 0) {
    lines.push(
      `Not run by the gate, so still yours to run: ${others
        .map((command) => `\`${command.command}\``)
        .join(', ')}.`,
    );
  }
  if (rewriters) lines.push(rewriters);

  return lines.join('\n\n');
}

/** "`npm run format` rewrites files" — said once, so nobody runs it as a check. */
function rewriterNote(facts) {
  const notes = [
    ...(facts.rewriters ?? []).map((entry) => `\`${entry.command}\` rewrites files (\`${entry.body}\`); it is not a check.`),
    ...(facts.generated ?? []).map((entry) => `\`${entry.command}\` rewrites \`${entry.path}\`; it is not a check.`),
  ];
  return notes.length > 0 ? notes.join(' ') : null;
}

/**
 * The commands CI runs, in order, as one list a reader can paste.
 *
 * A job that regenerates a file and then diffs it is one command here, joined with `&&`:
 * the regenerate step alone rewrites the file and passes whatever it wrote.
 */
function ciCommands(gate) {
  const lines = gate.jobs.flatMap((job) => {
    const checks = job.diffChecks ?? [];
    if (checks.length === 0 || job.commands.length === 0) return job.commands;
    const last = `${job.commands.at(-1)} && git diff --exit-code ${checks.join(' ')}`;
    return [...job.commands.slice(0, -1), last];
  });
  return [...new Set(lines)];
}

/** A path in backticks only when it exists: the checker reads a backticked path as a claim. */
const pathOrPlain = (facts, file) => (facts.files.includes(file) ? `\`${file}\`` : file);

/**
 * CI is the gate, and no one local command reproduces it.
 *
 * A GitLab pipeline of one-check jobs, or a workflow job that runs its commands itself.
 * Saying "this repository names no single gate" there was false: CI is the gate, it is
 * just not one command. So the jobs are named with what each runs, and the commands are
 * listed once to run by hand.
 */
function renderCiGate(facts, rewriters) {
  const { gate, validation } = facts;
  const lines = ['### Validation commands\n'];
  const jobs = gate.jobs
    .map((job) => {
      const checks = job.diffChecks ?? [];
      const guard = checks.length > 0 ? `, then fails if ${checks.map((file) => pathOrPlain(facts, file)).join(', ')} changed` : '';
      return `${job.name} (${job.commands.map((command) => `\`${command}\``).join(', ')}${guard})`;
    })
    .join(', ');
  lines.push(`CI is the gate: \`${gate.ciFile}\` runs ${plural(gate.jobs.length, 'job')}: ${jobs}.`);
  if (gate.external) {
    lines.push(
      `It also includes configuration from outside this repository (\`include:\`), which NASO ` +
        'did not read; those jobs run in CI and are not listed here.',
    );
  }
  lines.push(
    `No single local command runs all of it. To run the same checks here:\n\n` +
      `\`\`\`bash\n${ciCommands(gate).join('\n')}\n\`\`\``,
  );

  const covered = new Set(gate.rawSteps ?? []);
  const others = validation.filter((command) => !covered.has(command.script));
  if (others.length > 0) {
    const listed = others.map((command) => `\`${command.command}\``).join(', ');
    // An include NASO could not read may well run these. "Not run" would be a claim about
    // configuration nobody here has seen.
    lines.push(
      gate.external
        ? `Not in the jobs NASO could read; the included configuration may run them: ${listed}.`
        : `Declared but not run by CI: ${listed}.`,
    );
  }
  if (rewriters) lines.push(rewriters);
  return lines.join('\n\n');
}

export async function renderBriefing(facts, { version, now }) {
  const parts = [];

  parts.push(
    `${NASO_START}\n${TEMPLATE_HEADER.replace('__VERSION__', version).replace('__DATE__', now)}`,
  );

  parts.push(`# ${facts.projectName} — Agent Instructions`);
  parts.push(`> Generated by NASO ${version} on ${now} from the ${countProvenance(facts)}.
> Every path below was read while this file was written, and every count is a count.
> Where NASO could not derive a fact, the section is absent rather than guessed at.
>
> Maintained through normal code review. NASO never regenerates this file
> wholesale; the pre-commit hook appends at most one line per genuinely new area.`);

  const dirs = facts.areas;
  const rootFiles = renderRootFiles(facts.entries, facts);
  const structure = [];
  if (dirs.length > 0) structure.push(dirs.map(describeEntry).join('\n'));
  if (rootFiles) structure.push(rootFiles);
  parts.push(`## Project Structure\n\n${structure.join('\n\n')}`);

  parts.push(
    `${AUTO_START}\n${AUTO_END}\n\n` +
      'New areas appear in the block above automatically as commits add them.',
  );

  const lookFirst = renderLookFirst(facts);
  if (lookFirst) {
    parts.push(`### Where To Look First\n\n${lookFirst.join('\n')}`);
  }

  if (facts.featureMap) {
    const rows = facts.featureMap.rows.slice(0, 20).map((row) => {
      const dir = `${facts.featureMap.dir}/${row.key}/`;
      const role = roleFor(row.key);
      return `| ${humanize(row.key)} | \`${dir}\` | ${plural(row.count, 'file')}${role ? `, ${role}` : ''} |`;
    });
    const omitted = facts.featureMap.rows.length - rows.length;
    const more = omitted > 0
      ? `\n\n${omitted} further director${omitted === 1 ? 'y' : 'ies'} exist under the same parent; this table is capped so the map stays scannable.`
      : '';
    parts.push(
      `## Feature To Folder Map\n\n` +
        `Read from the directory layout under \`${facts.featureMap.dir}/\`.\n\n` +
        `| Feature | Lives in | Notes |\n| --- | --- | --- |\n${rows.join('\n')}${more}`,
    );
  }

  const conventions = renderConventions(facts);
  const warnings = (await scanWarnings(facts)).filter((warning) => warning.where === 'briefing');
  const warningText = warnings.length
    ? `\n\n${warnings.map((w) => `**WARN** ${w.headline}: ${w.detail}. Tracked files read as covered; nothing runs them unless the script names them.`).join('\n\n')}`
    : '';

  if (conventions) {
    const validation = renderValidation(facts);
    parts.push(`## Code Conventions\n\n${conventions.join('\n')}${warningText}${validation ? `\n\n${validation}` : ''}`);
  } else if (renderValidation(facts)) {
    parts.push(`## Validation\n\n${renderValidation(facts)}${warningText}`);
  } else if (warningText) {
    parts.push(`## Validation\n\n${warningText.trim()}`);
  }

  parts.push(`## Scope

Before editing, name the path prefixes the task owns; the pre-commit hook reports
staged paths outside them, and refuses them with \`NASO_SCOPE_STRICT=1\`:

\`\`\`bash
export NASO_SCOPE=path/to/area,other/area
\`\`\`

The hook runs only where setup installed it, from .git/hooks on that machine; CI does not run it,
and a fresh clone has none until setup runs there. Every rule below that names the hook holds on
that machine only. It checks staged files for secret-shaped lines, scope, format and lint, and
adds a line here for a new top-level area; its branch-name check only warns. It does not
type-check, run tests or read the commit message. If .naso/tooling/ is missing it prints one
line and lets the commit through.`);

  const boundaries = await renderBoundaries(facts);
  if (boundaries) parts.push(`## Boundaries\n\n${boundaries.join('\n')}`);

  parts.push(`## Secrets

The pre-commit hook refuses staged lines shaped like keys and tokens, and reports
the path and rule, never the value. Do the same: if a secret is already committed,
report its path and stop.`);

  parts.push(`## Commit Standard\n\n${renderCommitStandard(facts).join('\n')}`);

  const done = renderWhenDone(facts);
  if (done) parts.push(`## When Done\n\n${done}`);

  parts.push(`${NASO_END}`);

  return `${parts.join('\n\n')}\n`;
}
