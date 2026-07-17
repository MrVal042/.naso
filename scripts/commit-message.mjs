#!/usr/bin/env node
// NASO Commit Message — drafts a commit message from the staged diff using
// the local "fast" model declared in models/registry.yaml (LM Studio, or
// any OpenAI-compatible local server). Prints the draft for the operator
// to review and edit — never commits anything itself.
//
// This is a generative convenience tool, not a gate: doctor.mjs,
// validate.mjs, and guard.mjs stay deterministic on purpose (see
// ai/model-behavior.md's "Model Independence" section). If the local
// server isn't reachable, this fails clearly rather than blocking anything.
//
// Usage: node .naso/scripts/commit-message.mjs [target-dir]
// Zero external dependencies — Node.js core modules only (built-in fetch).

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pathExists, run } from './lib.mjs';

const MAX_DIFF_CHARS = 12000; // keep the request small enough for a local model's context window
const REQUEST_TIMEOUT_MS = 60_000; // fail fast and clearly rather than hang on a stuck local server
const MAX_RESPONSE_TOKENS = 400; // a commit message needs a fraction of this — bounds worst-case latency

const SYSTEM_PROMPT = `You are drafting a git commit message under NASO engineering standards.
Rules:
- Summarize the "why", not a line-by-line restatement of the diff.
- One concise summary line (max ~72 characters), imperative mood.
- Optionally a short body explaining rationale, only if genuinely useful.
- Never invent changes that are not present in the diff.
- Never fabricate ticket numbers, authors, or context not present in the diff.
Output only the commit message text. No commentary, no markdown fences.`;

const SUMMARY_SYSTEM_PROMPT = `${SYSTEM_PROMPT}
- You are given a file-change list, not the actual diff content — it was too
  large to include. Describe the scope of the change from the file paths
  and change types only. Do not guess at specifics the file list can't tell
  you (no invented rationale, no invented implementation details).`;

/**
 * A minimal parser for the flat mapping/list shape this repo's own
 * models/registry.yaml uses. Not a general YAML parser — deliberately
 * scoped to a file NASO itself authors and controls, per ADR-0002's
 * preference for small, direct code over a generic parser/compiler.
 */
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root, key: null, parent: null }];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];

    if (trimmed.startsWith('- ')) {
      const value = stripQuotes(trimmed.slice(2).trim());
      if (!Array.isArray(top.node)) {
        const arr = [];
        top.parent[top.key] = arr;
        top.node = arr;
      }
      top.node.push(value);
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const rest = trimmed.slice(colonIndex + 1).trim();
    const container = top.node;

    if (rest === '') {
      const placeholder = {};
      container[key] = placeholder;
      stack.push({ indent, node: placeholder, key, parent: container });
    } else {
      container[key] = stripQuotes(rest);
    }
  }

  return root;
}

function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, '');
}

async function main() {
  const targetArg = process.argv[2];
  const cwd = path.resolve(targetArg ?? process.cwd());

  if (!(await pathExists(cwd))) {
    console.error(`naso commit-message: target directory does not exist: ${cwd}`);
    process.exitCode = 1;
    return;
  }

  const diffRes = await run('git', ['diff', '--cached'], { cwd });
  if (!diffRes.ok) {
    console.error('naso commit-message: unable to read staged diff (not a git repository?).');
    process.exitCode = 1;
    return;
  }
  if (!diffRes.stdout.trim()) {
    console.error('naso commit-message: nothing staged. Stage changes with `git add` first.');
    process.exitCode = 1;
    return;
  }

  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const nasoDir = path.resolve(scriptsDir, '..');
  const registryPath = path.join(nasoDir, 'models', 'registry.yaml');

  let registry;
  try {
    registry = parseSimpleYaml(await readFile(registryPath, 'utf8'));
  } catch (err) {
    console.error(`naso commit-message: unable to read ${registryPath} — ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const model = registry.models?.fast;
  const provider = registry.providers?.[model?.provider];

  if (!model?.id || !provider?.base_url) {
    console.error(
      'naso commit-message: no "fast" model with a configured provider in models/registry.yaml.',
    );
    process.exitCode = 1;
    return;
  }

  // A diff over the cap gets silently truncated mid-file if sliced naively,
  // which biases the model toward whichever files sort first alphabetically
  // and produces a summary that looks complete but isn't (this happened in
  // practice — see roadmap.md Phase 6). Fall back to the full file-change
  // list instead: smaller, and every file is represented, not just the
  // first ones to fit.
  let systemPrompt = SYSTEM_PROMPT;
  let userContent;
  let usedFallback = false;

  if (diffRes.stdout.length <= MAX_DIFF_CHARS) {
    userContent = `Staged diff:\n\n${diffRes.stdout}`;
  } else {
    const statusRes = await run('git', ['diff', '--cached', '--name-status'], { cwd });
    const fileList = statusRes.ok ? statusRes.stdout.trim() : '(unable to list changed files)';
    systemPrompt = SUMMARY_SYSTEM_PROMPT;
    userContent = `Changed files (${diffRes.stdout.length} char diff was too large to include):\n\n${fileList}`;
    usedFallback = true;
    console.error(
      `naso commit-message: diff is ${diffRes.stdout.length} chars (cap ${MAX_DIFF_CHARS}) — ` +
        'drafting from the file list instead of the full diff. Review the draft extra carefully.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${provider.base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: model.id,
        temperature: 0.2,
        max_tokens: MAX_RESPONSE_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          // "/no_think" is a Qwen3-family convention that skips its extended
          // reasoning mode. Harmless no-op text for other models — remove if
          // models/registry.yaml's "fast" model ever changes to one that
          // doesn't support it.
          { role: 'user', content: `${userContent}\n\n/no_think` },
        ],
      }),
    });
  } catch (err) {
    const reason =
      err.name === 'AbortError'
        ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
        : err.message;
    console.error(
      `naso commit-message: could not reach ${provider.base_url} — is the local model server running?\n${reason}`,
    );
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    console.error(`naso commit-message: local model server returned HTTP ${response.status}.`);
    process.exitCode = 1;
    return;
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  const message = choice?.message?.content?.trim();

  if (!message) {
    const truncated = choice?.finish_reason === 'length';
    console.error(
      truncated
        ? `naso commit-message: model hit the ${MAX_RESPONSE_TOKENS}-token cap before producing output (likely spent it on reasoning). Try again or raise MAX_RESPONSE_TOKENS.`
        : 'naso commit-message: local model returned no content.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(message);

  if (usedFallback) {
    console.error(
      '\n(Drafted from the file list only — the full diff was too large to include. Double-check before using.)',
    );
  }
}

main().catch((err) => {
  console.error(`naso commit-message: unexpected error — ${err?.stack ?? err}`);
  process.exitCode = 1;
});
