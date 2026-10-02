// Shared zero-dependency helpers for the NASO tools in this directory.
// Built entirely on Node.js core modules — no npm packages.

import { access, readFile, constants } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/** Does a path exist on disk? */
export async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a JSON file. Returns null if missing or invalid. */
export async function readJSONFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Return the first candidate filename that exists directly under cwd. */
export async function firstExisting(cwd, candidates) {
  for (const name of candidates) {
    if (await pathExists(path.join(cwd, name))) return name;
  }
  return null;
}

/** Return every candidate filename that exists directly under cwd. */
export async function allExisting(cwd, candidates) {
  const found = [];
  for (const name of candidates) {
    if (await pathExists(path.join(cwd, name))) found.push(name);
  }
  return found;
}

/**
 * Run a command safely (array args, no shell interpolation).
 * By default captures stdout/stderr. Pass { inherit: true } to stream
 * output directly to the parent process instead (useful for lint/test/tsc).
 * Never throws — command failures and spawn errors both resolve normally.
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd ?? process.cwd(),
        stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }

    let stdout = '';
    let stderr = '';

    if (!opts.inherit) {
      child.stdout?.on('data', (chunk) => (stdout += chunk));
      child.stderr?.on('data', (chunk) => (stderr += chunk));
    }

    child.on('error', (err) => {
      resolve({ ok: false, code: -1, stdout, stderr: String(err?.message ?? err) });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

const KNOWN_PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'];

/** Detect the JS package manager from the packageManager field or lockfiles. */
export async function detectPackageManager(cwd, pkg) {
  if (pkg?.packageManager) {
    const name = String(pkg.packageManager).split('@')[0];
    if (KNOWN_PACKAGE_MANAGERS.includes(name)) return name;
  }
  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (
    (await pathExists(path.join(cwd, 'bun.lockb'))) ||
    (await pathExists(path.join(cwd, 'bun.lock')))
  ) {
    return 'bun';
  }
  if (await pathExists(path.join(cwd, 'package-lock.json'))) return 'npm';
  return pkg ? 'npm' : null;
}

/** Build [cmd, args] to run a package.json script via the detected package manager. */
export function pmRunCommand(pm, scriptName) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', ['run', scriptName]];
    case 'yarn':
      return ['yarn', ['run', scriptName]];
    case 'bun':
      return ['bun', ['run', scriptName]];
    case 'npm':
    default:
      return ['npm', ['run', scriptName]];
  }
}

/** Build [cmd, args] to execute a locally-installed binary via the detected package manager. */
export function pmExecCommand(pm, bin, args = []) {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', ['exec', bin, ...args]];
    case 'yarn':
      return ['yarn', [bin, ...args]];
    case 'bun':
      return ['bunx', [bin, ...args]];
    case 'npm':
    default:
      return ['npx', ['--no-install', bin, ...args]];
  }
}

/** Does a locally-installed binary exist in node_modules/.bin? */
export async function hasLocalBin(cwd, bin) {
  const binName = process.platform === 'win32' ? `${bin}.cmd` : bin;
  return pathExists(path.join(cwd, 'node_modules', '.bin', binName));
}

/** Collect git branch, working-tree status, and ahead/behind vs upstream. Null if not a repo. */
export async function getGitInfo(cwd) {
  const isRepo = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!isRepo.ok) return null;

  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = branchRes.ok ? branchRes.stdout.trim() : 'unknown';

  const statusRes = await run('git', ['status', '--porcelain'], { cwd });
  const changes = statusRes.ok ? statusRes.stdout.split('\n').filter(Boolean) : [];

  const upstreamRes = await run(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd },
  );

  let upstream = null;
  let ahead = 0;
  let behind = 0;

  if (upstreamRes.ok) {
    upstream = upstreamRes.stdout.trim();
    const countRes = await run(
      'git',
      ['rev-list', '--left-right', '--count', `${upstream}...HEAD`],
      { cwd },
    );
    if (countRes.ok) {
      const [b, a] = countRes.stdout.trim().split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
  }

  return { branch, changes, upstream, ahead, behind };
}

/** Split NUL-delimited git output into fields, dropping the empty tail. */
export function splitNul(stdout) {
  return String(stdout).split('\0').filter((field) => field.length > 0);
}

/**
 * Parse `git status --porcelain -z` into { status, path, from } entries.
 *
 * `-z`, always, for two reasons. A newline-delimited status breaks on any filename
 * containing one, and git *quotes* a path with a non-ASCII character unless
 * `core.quotePath` is off — so `café/` arrives as `"caf\303\251/"`, which no command line
 * and no human can paste. NUL output is the only form where every byte of the name
 * survives, and it is unambiguous.
 *
 * A rename or copy record is `XY new\0old\0` — the destination comes first, then the
 * source in its own field. Parsing it as a line would leave the source stranded and
 * shift every record after it, which is the kind of bug that shows up as one mysterious
 * unlisted file rather than as a crash.
 */
export function parseGitStatusPorcelainZ(raw) {
  const fields = String(raw).split('\0');
  const entries = [];
  let i = 0;

  while (i < fields.length) {
    const record = fields[i++];
    if (record.length < 4) continue; // trailing empty, or a truncated tail

    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    // A rename or copy consumes a second field; everything else does not.
    const from = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C'
      ? (fields[i++] ?? null)
      : null;

    entries.push({ status: status.trim() || '??', path: filePath, from });
  }

  return entries;
}

/** Parse `git status --porcelain`, newline form. Kept for the doctor and for tests. */
export function parseGitStatusPorcelain(raw) {
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || '??';
      const rawPath = line.slice(3).trim();
      const filePath = rawPath.includes(' -> ')
        ? (rawPath.split(' -> ').at(-1)?.trim() ?? rawPath)
        : rawPath;
      return { status, path: filePath, from: null };
    });
}

/** Paths currently staged for commit (added/copied/modified/renamed — not deleted). */
export async function getStagedFiles(cwd) {
  const res = await run(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd },
  );
  return res.ok ? splitNul(res.stdout) : [];
}

/**
 * Minimal argv parser shared by every script's CLI.
 *
 * Supports `--flag` and `--key=value` and `--key value`. The returned `flags`
 * Set holds bare flags; `values` holds the last `--key=value` or `--key value`
 * seen for each key, so `--scope src,docs` works without a bespoke parser.
 */
export function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    // Only treat the next token as this flag's value if it isn't another flag.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(body, next);
      i++;
    } else {
      flags.add(body);
    }
  }

  return { flags, values, positional };
}

// ---------------------------------------------------------------------------
// Briefing coverage
// ---------------------------------------------------------------------------

// Root-level entries that never say anything about a codebase's shape.
const ROOT_NOISE = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitkeep',
  '.npmrc',
  '.nvmrc',
  'license',
  'licence',
  'notice',
  'readme',
]);

// Directories whose presence is not news about the repo's structure.
const NOISY_DIR_PATTERN =
  /^(node_modules|dist|build|out|coverage|vendor|__pycache__|target|\.venv|venv|\.next|\.nuxt|\.output|\.turbo|\.svelte-kit|\.gradle|\.idea|\.vscode|\.cache|tmp|temp|logs?)$/i;

/**
 * Is this root-level filename noise rather than structure?
 *
 * The extension is ignored, because `README.md`, `LICENSE` and `NOTICE.txt` are
 * the same three files wearing different hats — and a briefing that lists
 * `README.md` as an "area" has told the reader nothing.
 */
export function isRootNoise(name) {
  const base = name.toLowerCase();
  if (ROOT_NOISE.has(base)) return true;
  const ext = path.extname(base);
  return Boolean(ext) && ROOT_NOISE.has(base.slice(0, -ext.length));
}

/** Is this directory name build output or tooling rather than project structure? */
export function isNoisyDir(name) {
  return NOISY_DIR_PATTERN.test(name);
}

/**
 * Does the briefing already cover this unit?
 *
 * A plain substring test is wrong in the direction that matters. If the
 * briefing mentions `apps/web/docs/`, a naive `includes('docs/')` says a new
 * top-level `docs/` is covered — it is not, they are different areas, and the
 * briefing would tell the next agent to look in the wrong place.
 *
 * So a match only counts when the unit is not immediately preceded by a path
 * character. `[A-Za-z0-9_./-]` covers the separators and the characters that
 * can legally appear in the preceding segment, which is exactly the set of
 * cases where the match is a suffix of a longer path rather than the path
 * itself. Case-insensitive, because a briefing that says `Docs/` covers `docs/`.
 */
export function coversUnit(briefingText, unit) {
  if (!briefingText || !unit) return false;
  const needle = escapeRegExp(unit);
  return new RegExp(`(^|[^A-Za-z0-9_./-])${needle}`, 'i').test(briefingText);
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count unfilled markers in a briefing.
 *
 * TODO(fill) comes from the template; TODO(describe) is what validate.mjs
 * appends for a newly-appeared area. Both mean "an agent still owes work here".
 */
export function countTodoMarkers(text) {
  const matches = String(text ?? '').match(/TODO\((fill|describe)\)/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// NASO tool identity
// ---------------------------------------------------------------------------

/** Where a human goes when the tooling does something they did not expect. */
export const SUPPORT_EMAIL = 'contactmrval@gmail.com';

/**
 * The tools this directory ships, in the order setup presents them.
 *
 * Kept as data rather than prose so `setup`, `doctor` and `guide` cannot drift
 * apart: all three read this list, so a tool that is added here appears in the
 * confirmation screen and in the diagnostics without a second edit.
 */
export const TOOLS = [
  {
    name: 'briefing',
    file: 'briefing.mjs',
    blurb: 'Scan this repository, then write or re-verify the NASO block in AGENTS.md',
  },
  {
    name: 'guide',
    file: 'guide.mjs',
    blurb: 'Read back one area — or the whole briefing — against the code',
  },
  {
    name: 'validate',
    file: 'validate.mjs',
    blurb: 'Pre-commit gate: secret blocking, scope, format, lint, briefing upkeep',
  },
  {
    name: 'doctor',
    file: 'doctor.mjs',
    blurb: 'Check Node, git, the vendored copy, the hook, the briefing and the install',
  },
  {
    name: 'refresh',
    file: 'refresh.mjs',
    blurb: 'After upgrading: re-copy the toolset, move the version stamp, reinstall the hook',
  },
  {
    name: 'setup',
    file: 'setup.mjs',
    blurb: 'The one-time install: read the repository, plan, then write on your accept',
  },
];

/** Absolute path to the `.naso` tool directory these tools live in. */
export function nasoDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Current tool version, read from `<naso>/VERSION`. */
export async function toolVersion() {
  try {
    const raw = await readFile(path.join(nasoDir(), 'VERSION'), 'utf8');
    return raw.trim();
  } catch {
    return '0.0.0';
  }
}

/**
 * Is a human sitting at this terminal?
 *
 * Everything that can prompt checks this first. A prompt written to a
 * non-interactive stream — CI, a pipe, `npx naso-dev setup | tee log` — blocks
 * forever on input nobody can type, which is a far worse failure than refusing
 * to run and printing the same information as plain text.
 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Best-effort human identity for the machine running a script. */
export function actorIdentity() {
  const user = os.userInfo?.().username ?? os.userInfo?.().username ?? 'unknown';
  return `${user}@${os.hostname()}`;
}

/**
 * Compare two dotted version strings.
 * Returns -1 / 0 / 1 so callers can use it directly.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Staged content scan
// ---------------------------------------------------------------------------

/**
 * Content rules for leaked credentials. Every pattern is an unambiguous shape
 * — something that is a secret by construction, never a word that merely
 * appears near credentials. Reporting is `file:line  rule-name` only; the
 * matched text is never returned or printed, so a finding is safe to log.
 */
export const CONTENT_RULES = [
  { name: 'PEM_PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS_ACCESS_KEY_ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'STRIPE_SECRET_KEY', pattern: /\b(?:sk_live|sk_test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'GITHUB_TOKEN', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'SLACK_TOKEN', pattern: /\bxox[baprs]-/ },
];

/** Escape hatch for a line that legitimately contains a secret-shaped string. */
const ALLOW_MARKER = 'naso-allow-secret';

const LOCKFILE_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock|Pipfile\.lock|Podfile\.lock|packages\.lock\.json)$/i;

/**
 * Parse `git diff --cached -U0` into per-file added lines.
 *
 * Only added lines are considered: a secret already in history is a separate
 * (much larger) problem, and scanning context lines would re-report unchanged
 * content on every subsequent commit.
 *
 * Binary files are skipped — the hunk header for one carries no line data, so
 * they simply produce no entries.
 */
export function parseAddedLines(diffText) {
  const files = new Map();
  let current = null;
  // New-file line number of the next `+` line, seeded from the @@ hunk header.
  let nextLine = 0;

  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (rawLine.startsWith('@@')) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const m = rawLine.match(/^@@[^@]*\+(\d+)/);
      if (m) nextLine = Number.parseInt(m[1], 10);
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      // "+++ /dev/null" means the file was deleted; nothing to scan.
      if (target === '/dev/null') {
        current = null;
        continue;
      }
      // Unquote before stripping the b/ prefix: git quotes the *whole* header
      // (`+++ "b/caf\303\251.env"`), so the prefix is inside the quotes and a
      // replace(/^b\//) on the raw line finds nothing.
      current = unquoteGitPath(target).replace(/^b\//, '');
      files.set(current, []);
      continue;
    }
    // "Binary files ... differ" — skip, no line data follows.
    if (rawLine.startsWith('Binary files ')) {
      current = null;
      continue;
    }
    if (!current || !rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;

    // A `+` line is a real line in the new file at nextLine; a context or `-`
    // line still occupies a position, so advance on every non-metadata line.
    const lines = files.get(current);
    if (rawLine.startsWith('+')) {
      lines.push({ text: rawLine.slice(1), line: nextLine });
      nextLine++;
    } else if (rawLine.startsWith('-')) {
      // Deleted lines do not advance the new-file counter.
    } else {
      nextLine++;
    }
  }

  return files;
}

/**
 * Find content-rule hits across the staged diff.
 * Returns [{ path, line, rule }] — never the matched text.
 */
export function scanAddedLines(files) {
  const hits = [];
  for (const [filePath, entries] of files) {
    // Lockfiles contain hashes that trip these shapes constantly.
    if (LOCKFILE_PATTERN.test(filePath)) continue;

    for (const { text, line } of entries) {
      if (text.includes(ALLOW_MARKER)) continue;
      for (const rule of CONTENT_RULES) {
        if (rule.pattern.test(text)) hits.push({ path: filePath, line, rule: rule.name });
      }
    }
  }
  return hits;
}

/**
 * Turn git's C-style quoted path back into the path.
 *
 * With `core.quotePath` off — and `scanStagedContent` always passes it off — a path
 * containing a quote, a control character or a backslash is still emitted wrapped in
 * double quotes with `\nnn` octal escapes, because there is no other way to keep the
 * header parseable. Decoding is therefore not optional tidiness: without it, a file
 * genuinely named `he"llo.ts` is reported under a name that does not exist, and a
 * hit attributed to it cannot be found in an editor to be removed.
 */
export function unquoteGitPath(value) {
  const raw = String(value);
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;

  const body = raw.slice(1, -1);
  let out = '';
  // Octal escapes are bytes, not code points: `\303\251` is one character, é, and
  // decoding each escape as a code unit would hand back `Ã©`. Consecutive escapes are
  // therefore collected and decoded as UTF-8 as a group, while the literal text
  // between them is already a decoded JS string and passes straight through.
  let bytes = [];

  const flushBytes = () => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString('utf8');
      bytes = [];
    }
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      flushBytes();
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next >= '0' && next <= '7') {
      const octal = body.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        i += 3;
        continue;
      }
    }
    flushBytes();
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 't') { out += '\t'; i += 1; continue; }
    if (next === 'r') { out += '\r'; i += 1; continue; }
    if (next === '"' || next === '\\') { out += next; i += 1; continue; }
    out += next ?? '';
    i += 1;
  }
  flushBytes();
  return out;
}

/** Run the staged-diff content scan for a repository. */
export async function scanStagedContent(cwd) {
  // core.quotePath=false keeps `é.env` readable; unquoteGitPath handles the rest,
  // since a path with a quote or a control character is quoted whether or not you asked.
  const res = await run(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--cached', '-U0'],
    { cwd },
  );
  if (!res.ok) return [];
  return scanAddedLines(parseAddedLines(res.stdout));
}

/**
 * Is this module the process entry point?
 *
 * Scripts here both export helpers (for test/naso.test.mjs to import) and run
 * main() on load. Without this guard, importing one from the test suite would
 * execute its CLI against whatever directory the test happened to run in.
 */
export function isMainModule(importMetaUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const asUrl = fileURLToPath(importMetaUrl);
    // Compare real paths, not resolved strings. On macOS `/tmp` and `/var` are
    // symlinks: the ESM loader reports the real path in import.meta.url while
    // process.argv[1] keeps the symlinked one, so `path.resolve` alone would say a
    // vendored tool invoked from a temp directory is not the main module and it
    // would exit silently with code 0.
    const real = (p) => {
      try {
        return realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    };
    return real(invoked) === real(asUrl);
  } catch {
    return false;
  }
}

/** Escape a string for safe single-quoted use inside a POSIX shell script. */
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Normalize a path for embedding in a `#!/bin/sh` hook.
 *
 * Git for Windows runs hooks through its bundled POSIX shell, so the hook
 * script itself must stay POSIX. But the *paths* inside it may come from a
 * Windows drive (`C:\Users\Ada Lovelace\project`) where backslashes are
 * meaningful and the shell's own PATH separator rules differ. Converting to
 * forward slashes and quoting is what makes one hook body valid on both
 * platforms.
 */
export function toPosixPath(value) {
  const p = String(value);
  if (p.includes('\\')) return p.replaceAll('\\', '/');
  return p;
}

// ---------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------

// No colour, no box drawing. These tools get piped into CI logs, issue bodies and
// chat messages, and an escape sequence in a copied-paste error report helps
// nobody. Structure comes from whitespace and headings instead.

/** `# NASO <tool> — <subject>` header every tool prints first. */
export function banner(tool, subject) {
  console.log(`# NASO ${tool} — ${subject}\n`);
}

/** A titled block inside a tool's output. */
export function section(title) {
  console.log(`## ${title}`);
}

/** A status line with a fixed-width, text-only marker. */
const ICONS = { pass: 'OK  ', fail: 'FAIL', warn: 'WARN', skip: 'SKIP', info: '    ' };

export function status(kind, message) {
  console.log(`${ICONS[kind] ?? ICONS.info} ${message}`);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Ask a yes/no question. Returns the default when the answer is just Enter. */
export async function promptYesNo(question, { defaultYes = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Ask the user to pick one of a numbered list. Returns the chosen index.
 *
 * Accepts the number, or the first few letters of a label, because typing
 * "2" is faster than typing a whole label and typing a label is faster than
 * counting down a list of eight.
 */
export async function promptChoice(question, choices) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(question);
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}) ${choice.label}`);
    });
    for (;;) {
      const answer = (await rl.question(`Choose 1-${choices.length} [1]: `)).trim();
      if (answer === '') return 0;

      const asNumber = Number.parseInt(answer, 10);
      if (String(asNumber) === answer && asNumber >= 1 && asNumber <= choices.length) {
        return asNumber - 1;
      }

      const byLabel = choices.findIndex((choice) =>
        choice.label.toLowerCase().startsWith(answer.toLowerCase()),
      );
      if (byLabel !== -1) return byLabel;

      console.log(`  "${answer}" is not one of the options.`);
    }
  } finally {
    rl.close();
  }
}

/**
 * A support request pre-filled with everything a maintainer would ask for.
 *
 * The point of a template is that the reader does not have to remember what a
 * maintainer needs. Every field here is something only the reporter's machine
 * can produce, so the reply can start with the facts instead of a questionnaire.
 */
export async function supportTemplate({ command, targetDir, version, actor, now }) {
  const git = await gitVersionOrUnknown();

  return `Subject: NASO ${version} — setup did not behave as documented

Hi, I ran NASO setup and it did not do what the README says. Details below.

--- REPORT ---
NASO version:   ${version}
Command:        ${command}
Repository:     ${targetDir}
Machine:        ${actor}
Date:           ${now}
Platform:       ${process.platform} ${process.arch}
Node:           ${process.version}
Git:            ${git}

--- WHAT I EXPECTED ---
(paste the step number from the README, e.g. "step 3 should write AGENTS.md")

--- WHAT HAPPENED ---
(paste the full terminal output, including any FAIL or WARN lines)

--- REPO STATE ---
  git status --porcelain : (paste the output)
  does AGENTS.md exist? : yes / no
  is .git/hooks/pre-commit installed? : yes / no

--- WHAT I TRIED ---
(e.g. re-running the command, deleting AGENTS.md first, --track flag, etc.)

--- SECRET CHECK ---
Please redact any credentials, tokens, customer names or internal URLs before
sending. Paths, versions and error output are enough to diagnose this.
`;
}

async function gitVersionOrUnknown() {
  const res = await run('git', ['--version']);
  return res.ok ? res.stdout.trim() : 'not found';
}

