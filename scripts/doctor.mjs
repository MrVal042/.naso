#!/usr/bin/env node
// NASO Doctor — scans the current project and prints a concise Markdown
// summary of its tech stack, tooling, and git state for an AI agent to read.
//
// Usage: node .naso/scripts/doctor.mjs [target-dir]
// Zero external dependencies — Node.js core modules only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  pathExists,
  readJSONFile,
  allExisting,
  detectPackageManager,
  getGitInfo,
} from './lib.mjs';

const STACK_MARKERS = [
  { label: 'Node.js', files: ['package.json'] },
  { label: 'TypeScript', files: ['tsconfig.json'] },
  { label: 'Ruby', files: ['Gemfile'] },
  { label: 'Python', files: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] },
  { label: 'Go', files: ['go.mod'] },
  { label: 'Rust', files: ['Cargo.toml'] },
  { label: 'PHP', files: ['composer.json'] },
  { label: 'Java (Maven)', files: ['pom.xml'] },
  { label: 'Java/Kotlin (Gradle)', files: ['build.gradle', 'build.gradle.kts'] },
  { label: 'Elixir', files: ['mix.exs'] },
];

const LINT_CONFIG_CANDIDATES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
];

const FORMAT_CONFIG_CANDIDATES = [
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.mjs',
  '.editorconfig',
];

async function detectStack(cwd) {
  const found = [];
  for (const marker of STACK_MARKERS) {
    const matches = await allExisting(cwd, marker.files);
    if (matches.length > 0) found.push({ label: marker.label, files: matches });
  }
  return found;
}

async function detectNasoIntegration(cwd) {
  const agentsPath = path.join(cwd, '.agents', 'AGENTS.md');
  const localNasoPath = path.join(cwd, '.naso');

  const hasAgentsFile = await pathExists(agentsPath);
  const hasLocalNaso = await pathExists(localNasoPath);

  let referencesNaso = false;
  if (hasAgentsFile) {
    try {
      const content = await readFile(agentsPath, 'utf8');
      referencesNaso = content.includes('.naso');
    } catch {
      referencesNaso = false;
    }
  }

  return { hasAgentsFile, hasLocalNaso, referencesNaso };
}

function formatChangeList(changes, limit = 15) {
  if (changes.length === 0) return '_No uncommitted changes._';
  const shown = changes.slice(0, limit).map((line) => `- \`${line}\``);
  const remainder = changes.length - shown.length;
  if (remainder > 0) shown.push(`- _...and ${remainder} more_`);
  return shown.join('\n');
}

async function main() {
  const targetArg = process.argv[2];
  const cwd = path.resolve(targetArg ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso doctor: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const pkg = await readJSONFile(path.join(cwd, 'package.json'));
  const [stack, packageManager, git, naso, lintConfigs, formatConfigs] = await Promise.all([
    detectStack(cwd),
    detectPackageManager(cwd, pkg),
    getGitInfo(cwd),
    detectNasoIntegration(cwd),
    allExisting(cwd, LINT_CONFIG_CANDIDATES),
    allExisting(cwd, FORMAT_CONFIG_CANDIDATES),
  ]);

  const lines = [];
  const push = (line = '') => lines.push(line);

  push(`# NASO Doctor Report`);
  push();
  push(`- **Project path:** \`${cwd}\``);
  push(`- **Generated:** ${new Date().toISOString()}`);
  push(`- **Node.js:** ${process.version} on ${os.platform()}/${os.arch()}`);
  push();

  push(`## Tech Stack`);
  push();
  if (stack.length === 0) {
    push('_No recognized stack markers found (no package.json, tsconfig.json, Gemfile, requirements.txt, etc.)._');
  } else {
    for (const entry of stack) {
      push(`- **${entry.label}** — found ${entry.files.map((f) => `\`${f}\``).join(', ')}`);
    }
  }
  if (pkg?.name) {
    push(`- **Package name:** \`${pkg.name}\`${pkg.version ? ` (v${pkg.version})` : ''}`);
  }
  push();

  push(`## Package Manager`);
  push();
  push(packageManager ? `- Detected: **${packageManager}**` : '- No JavaScript package manager detected.');
  push();

  push(`## Git Status`);
  push();
  if (!git) {
    push('_Not a git repository (or git is unavailable)._');
  } else {
    push(`- **Branch:** \`${git.branch}\``);
    if (git.upstream) {
      push(`- **Upstream:** \`${git.upstream}\` (ahead ${git.ahead}, behind ${git.behind})`);
      if (git.ahead === 0 && git.behind === 0) {
        push('- **Sync status:** up to date with upstream');
      } else if (git.behind > 0) {
        push('- **Sync status:** behind upstream — consider pulling before continuing');
      } else {
        push('- **Sync status:** ahead of upstream — unpushed local commits');
      }
    } else {
      push('- **Upstream:** none configured');
    }
    push(`- **Working tree:** ${git.changes.length} changed file(s)`);
    push();
    push(formatChangeList(git.changes));
  }
  push();

  push(`## Configuration Files`);
  push();
  push(
    lintConfigs.length > 0
      ? `- **Lint config:** ${lintConfigs.map((f) => `\`${f}\``).join(', ')}`
      : '- **Lint config:** none found',
  );
  push(
    formatConfigs.length > 0
      ? `- **Format config:** ${formatConfigs.map((f) => `\`${f}\``).join(', ')}`
      : '- **Format config:** none found',
  );
  push();

  push(`## NASO Integration`);
  push();
  push(naso.hasLocalNaso ? '- `.naso/` present in this project.' : '- No local `.naso/` directory.');
  push(
    naso.hasAgentsFile
      ? `- \`.agents/AGENTS.md\` present${naso.referencesNaso ? ' and references `.naso`.' : ', but does not reference `.naso` — consider re-running bootstrap.'}`
      : '- No `.agents/AGENTS.md` found — run `node .naso/scripts/bootstrap.mjs` to configure this project.',
  );
  push();

  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(`naso doctor: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
