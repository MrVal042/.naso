#!/usr/bin/env node
// NASO terminal presentation.
//
// One file, one job: decide whether this screen may contain colour, and if so
// return functions that wrap text in it. Every other module writes plain strings
// and lets this one style them, which is what keeps colour out of the modules
// that get vendored into a repository and run by a pre-commit hook — a hook that
// depends on picocolors cannot run on a machine that never ran npm install.
//
// The rule that matters: `style()` never throws and never changes the text it is
// given. Every function is total, so a broken colour decision costs colour and
// nothing else.
//
// Not vendored. See vendorSources().

import pc from 'picocolors';

/**
 * Whether this process may colour its output.
 *
 *   --no-color / --color   an explicit request on this invocation, and the only
 *                          one that can turn colour ON for a pipe
 *   NO_COLOR               set, any value, by anything from CI to the parent shell
 *   isTTY                  the fallback, and the only other input
 *
 * A pipe is not a terminal, so `npx naso-dev | tee log` gets plain text, and so
 * does anything run by an agent. That is the desired outcome: escape codes in a
 * captured buffer are noise, and a file written to be read later should not carry
 * the terminal it happened to be printed on.
 *
 * FORCE_COLOR is deliberately NOT honoured here, which is a departure from the
 * convention every other tool follows and it is worth saying why. npm sets
 * FORCE_COLOR in the environment of every script it runs, to colour its own
 * output, and it does not unset it for the child. So a tool that treats
 * FORCE_COLOR as a request colours its output when piped from `npm publish`,
 * `npm test` or `npm run` — that is, precisely when nobody is looking at a
 * terminal and the escape codes are captured into a file. It surfaced here as a
 * failing test: the publish gate ran the suite with FORCE_COLOR set by npm, and
 * the one assertion that reads the flow's own output got escape codes wrapped
 * around the word it was looking for.
 *
 * `--color` is the honest way to ask for colour in a pipe, because it is typed by
 * the person who wants it. An environment variable that a parent process sets for
 * its own reasons is not that.
 */
export function colorEnabled(flags = new Set(), stream = process.stdout) {
  if (flags.has('no-color') || flags.has('no-colour')) return false;
  if (flags.has('color') || flags.has('colour')) return true;

  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '0') return false;

  return Boolean(stream?.isTTY);
}

/** The style set: identity functions when colour is off, picocolors when it is on. */
export function createStyle(enabled = colorEnabled()) {
  const c = enabled ? pc : new Proxy({}, { get: () => (text) => String(text) });
  const identity = (text) => String(text);

  return {
    enabled,
    bold: (text) => c.bold(text),
    dim: (text) => c.dim(text),
    red: (text) => c.red(text),
    green: (text) => c.green(text),
    yellow: (text) => c.yellow(text),
    blue: (text) => c.blue(text),
    cyan: (text) => c.cyan(text),
    magenta: (text) => c.magenta(text),
    gray: (text) => c.gray(text),

    /** A `## Heading` the briefing format already uses, kept but made legible. */
    heading: (text) => c.bold(c.cyan(`## ${text}`)),

    /** A step counter, e.g. `1/3 read`. */
    step: (current, total, text) => c.dim(`[${current}/${total}]`) + ' ' + c.bold(text),

    /** A list marker that is not a hyphen, so a list reads as a list. */
    bullet: (text) => `${c.dim('•')} ${text}`,

    /** The affirmative. Used sparingly, so it means something. */
    ok: (text) => `${c.green('✓')} ${text}`,

    warn: (text) => `${c.yellow('!')} ${text}`,

    fail: (text) => `${c.red('✗')} ${text}`,

    /** Inline emphasis inside a sentence, for a path that must be copied exactly. */
    path: (text) => c.cyan(text),

    /** A flag the reader is meant to type. */
    flag: (text) => c.magenta(text),

    /** Nothing at all, for callers that must not style. */
    identity,
  };
}

export const plainStyle = createStyle(false);