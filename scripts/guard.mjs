#!/usr/bin/env node
// NASO Guard — stack-agnostic checks for leaked secrets, committed build
// output, unreviewed dependency changes, and out-of-scope edits.
//
// Generic by design: it matches path shapes, never project-specific names, and
// reports file paths, line numbers and rule names only. It never prints matched
// text, so a finding is safe to paste into a chat or a CI log.
//
// Two severities:
//
//   BLOCKS (--staged, i.e. the pre-commit hook)
//     ENV_FILE     .env and .env.*, minus the allowlist
//     SENSITIVE_EXT .pem .p12 .pfx .key
//     SSH_KEY      id_rsa*, id_ed25519*
//     SECRET_CONTENT  any content-scan rule hit on an added line
//
//   WARNS ONLY
//     COMPOUND     service-role, private-key, secret-key, api-key,
//                  access-key, jwt-secret anywhere in a path
//     SECRET_SEG   a path segment that is exactly secret/secrets/
//                  credential/credentials
//     GENERATED    dist, build, coverage, node_modules, .map, ...
//     DEPENDENCY   package.json, lockfiles, Cargo.toml, ...
//     SCOPE        paths outside --scope / NASO_SCOPE
//
// The broad `.*token.*` / `.*key.*` substring patterns this replaced flagged
// roughly one file in four, which trains an agent to ignore the output. The
// narrow rules below only match shapes that are secrets by construction.
//
// Usage:
//   node .naso/scripts/guard.mjs [target-dir] [--staged] [--strict]
//     [--scope <prefix,prefix,...>]
//
// Env: NASO_SCOPE (comma-separated prefixes), NASO_SCOPE_STRICT=1
//
// Zero external dependencies — Node.js core modules only.

import path from 'node:path';
import {
  pathExists,
  parseGitStatusPorcelain,
  getStagedFiles,
  parseArgs,
  run,
  scanStagedContent,
} from './lib.mjs';

// --- Secret path rules ------------------------------------------------------

const ENV_FILE = /(^|\/)\.env($|[./_-])/i;
const SENSITIVE_EXT = /\.(pem|p12|pfx|key)$/i;
const COMPOUND = /(service[-_]?role|private[-_]?key|secret[-_]?key|api[-_]?key|access[-_]?key|jwt[-_]?secret)/i;
const SSH_KEY = /(^|\/)id_(rsa|ed25519)/i;

/** Exact path segments that mean "this is a secret store". */
const SECRET_SEGMENTS = new Set(['secret', 'secrets', 'credential', 'credentials']);

// `.env.example` and friends are committed on purpose and hold no values.
const ENV_ALLOWLIST = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

const basename = (p) => p.split('/').at(-1) ?? p;

function isEnvAllowlisted(p) {
  return ENV_ALLOWLIST.has(basename(p).toLowerCase());
}

/** Split on / - _ . so `app-secret-store` yields segments ['app','secret','store']. */
function segments(p) {
  return p.toLowerCase().split(/[/._-]+/).filter(Boolean);
}

/** Classify one path against the secret rules. Returns rule names that hit. */
export function classifySecretPath(p) {
  const hits = [];
  const base = basename(p).toLowerCase();

  if (ENV_FILE.test(p) && !isEnvAllowlisted(p)) hits.push('ENV_FILE');
  if (SENSITIVE_EXT.test(p)) hits.push('SENSITIVE_EXT');
  if (SSH_KEY.test(p)) hits.push('SSH_KEY');
  // COMPOUND and SECRET_SEG are warn-only: they catch a suspicious name, not a
  // certain leak. design-tokens/x.ts must not trip either.
  if (COMPOUND.test(p)) hits.push('COMPOUND');
  if (segments(p).some((seg) => SECRET_SEGMENTS.has(seg))) hits.push('SECRET_SEG');

  // A `.key`/`.pem` file called `.env.example` is still allowlist-exempt by
  // name only when the *whole* basename is an allowlist entry, so drop the
  // duplicate report rather than double-counting the same file.
  return [...new Set(hits)].filter((rule) => !(isEnvAllowlisted(p) && rule === 'ENV_FILE'));
}

// --- Non-secret path rules --------------------------------------------------

const GENERATED_DIR_PATTERN =
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.output|\.turbo|\.svelte-kit|\.angular|vendor|__pycache__|target)(\/|$)/i;

const DEPENDENCY_DIR_PATTERN =
  /(^|\/)(node_modules|vendor|bower_components|\.venv|venv|\.tox|\.gradle)(\/|$)/i;

const SOURCE_MAP_PATTERN = /\.map$/i;

const DEPENDENCY_FILE_PATTERN =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|Pipfile|Pipfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle|build\.gradle\.kts|Podfile|Podfile\.lock)$/i;

// --- Scope -----------------------------------------------------------------

/** Files always inside scope, whatever NASO_SCOPE says. */
const SCOPE_ALWAYS_ALLOWED = new Set(['AGENTS.md', '.naso.lock']);

/**
 * Resolve scope prefixes from --scope or NASO_SCOPE.
 * Returns null when no scope is configured, meaning "do not check".
 */
export function resolveScope(flagValue, envValue) {
  const raw = flagValue ?? envValue;
  if (!raw) return null;
  const prefixes = raw
    .split(',')
    .map((p) => p.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
  return prefixes.length > 0 ? prefixes : null;
}

/** Is `p` inside at least one scope prefix? */
export function inScope(p, prefixes) {
  const normalized = p.replace(/\\/g, '/');
  return prefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function outOfScopePaths(paths, prefixes) {
  return paths
    .filter((p) => !inScope(p, prefixes))
    .filter((p) => !SCOPE_ALWAYS_ALLOWED.has(basename(p)))
    .sort();
}

// --- Reporting -------------------------------------------------------------

const WARNS = [
  {
    title: 'Secret-shaped paths changed (warn-only rules)',
    next: 'Confirm these are placeholders or names, not live values. Real secrets belong in a deployment secret store.',
    match: (p) => ['COMPOUND', 'SECRET_SEG'].some((r) => classifySecretPath(p).includes(r)),
  },
  {
    title: 'Generated, build-output, or dependency paths changed',
    next: 'Do not commit generated output or installed dependencies unless this repo explicitly tracks them.',
    match: (p) =>
      GENERATED_DIR_PATTERN.test(p) || DEPENDENCY_DIR_PATTERN.test(p) || SOURCE_MAP_PATTERN.test(p),
  },
  {
    title: 'Dependency manifest or lockfile changed',
    next: 'Confirm dependency changes are intentional before committing.',
    match: (p) => DEPENDENCY_FILE_PATTERN.test(p),
  },
];

async function getChangedPaths(cwd, staged) {
  if (staged) return getStagedFiles(cwd);
  const res = await run('git', ['status', '--porcelain'], { cwd });
  if (!res.ok) return null;
  return parseGitStatusPorcelain(res.stdout).map((entry) => entry.path);
}

async function main() {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const staged = flags.has('staged');
  const strict = flags.has('strict');
  const cwd = path.resolve(positional[0] ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso guard: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const prefixes = resolveScope(values.get('scope') ?? null, process.env.NASO_SCOPE);
  const strictScope = strict || process.env.NASO_SCOPE_STRICT === '1';

  const paths = await getChangedPaths(cwd, staged);
  if (paths === null) {
    console.error('naso guard: unable to read git status (not a git repository?).');
    process.exitCode = staged ? 1 : 0;
    return;
  }

  const blocks = [];
  const warns = [];

  // --- Blocking rules (staged mode only) -----------------------------------
  if (staged) {
    for (const p of paths) {
      for (const rule of classifySecretPath(p)) {
        if (['ENV_FILE', 'SENSITIVE_EXT', 'SSH_KEY'].includes(rule)) {
          blocks.push({ path: p, rule });
        }
      }
    }

    const contentHits = await scanStagedContent(cwd);
    for (const hit of contentHits) {
      blocks.push({ path: hit.path, rule: hit.rule, line: hit.line });
    }
  }

  // --- Warn-only rules -----------------------------------------------------
  for (const guidance of WARNS) {
    const files = Array.from(new Set(paths.filter(guidance.match))).sort();
    if (files.length > 0) warns.push({ title: guidance.title, files, next: guidance.next });
  }

  const outside = prefixes ? outOfScopePaths(paths, prefixes) : [];
  if (outside.length > 0) {
    warns.push({
      title: 'Out-of-scope paths changed',
      files: outside,
      next: `Only paths under ${prefixes.join(', ')} were in scope. Split unrelated work into its own commit.`,
      strict: strictScope,
    });
  }

  // --- Output --------------------------------------------------------------
  console.log(`# NASO Guard (${staged ? 'staged' : 'working tree'}) — ${cwd}`);
  console.log('');
  console.log(`Changed paths checked: ${paths.length}`);
  console.log(`Scope: ${prefixes ? prefixes.join(', ') : 'not set (no scope check)'}`);
  console.log(
    `Mode: ${staged ? 'blocks high-confidence secret rules, warns otherwise' : 'warn-only'}`,
  );
  console.log('');

  if (blocks.length > 0) {
    console.log('## BLOCKING — high-confidence secret rule match');
    for (const b of blocks) {
      const where = b.line ? `${b.path}:${b.line}` : b.path;
      console.log(`- ${where}  ${b.rule}`);
    }
    console.log(
      'Next: unstage the file and move the value to a deployment secret store.\n' +
        '      Path and rule only are shown; the matched text is never printed.',
    );
    console.log('');
  }

  if (warns.length === 0) {
    if (blocks.length === 0) console.log('No guard findings.');
  } else {
    for (const warning of warns) {
      console.log(`## ${warning.title}`);
      for (const filePath of warning.files) console.log(`- ${filePath}`);
      if (warning.strict) console.log('Next: BLOCKING — ' + warning.next);
      else console.log(`Next: ${warning.next}`);
      console.log('');
    }
  }

  const scopeBlocking = warns.some((w) => w.strict);

  if (blocks.length > 0) {
    console.log(`${blocks.length} blocking finding(s). Commit refused.`);
    process.exitCode = 1;
    return;
  }
  if (scopeBlocking) {
    console.log('Out-of-scope paths with strict scope enabled. Commit refused.');
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main().catch((err) => {
  console.error(`naso guard: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
