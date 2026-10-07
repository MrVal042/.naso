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
 * Whether this process may colour its output. First match wins:
 *
 *   --no-color / --no-colour        typed on this invocation: never colour
 *   NO_COLOR                        set to anything but "" or "0": no colour
 *   FORCE_COLOR / --color           colour, even into a pipe; FORCE_COLOR=0 or
 *                                   "false" asks for none
 *   isTTY                           otherwise, colour only a terminal
 *
 * FORCE_COLOR is honoured like every other tool honours it. npm sets it in the
 * environment of the scripts it runs, so a run under `npm test` or `npm run` may
 * be coloured into a pipe; NO_COLOR or --no-color is the way to say no, and both
 * outrank it.
 */
export function colorEnabled(flags = new Set(), stream = process.stdout, env = process.env) {
  if (flags.has('no-color') || flags.has('no-colour')) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '' && env.NO_COLOR !== '0') return false;
  if (flags.has('color') || flags.has('colour')) return true;
  if (env.FORCE_COLOR !== undefined) return !['0', 'false'].includes(String(env.FORCE_COLOR).toLowerCase());
  return Boolean(stream?.isTTY);
}

/** The style set: identity functions when colour is off, picocolors when it is on. */
export function createStyle(enabled = colorEnabled()) {
  // createColors(true), not the default export: picocolors makes its own decision from
  // the environment, and this module has already made it.
  const c = enabled ? pc.createColors(true) : new Proxy({}, { get: () => (text) => String(text) });
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