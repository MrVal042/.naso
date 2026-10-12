#!/usr/bin/env node
// NASO terminal prompts.
//
// The four the setup flow asks with — confirm, select, note, outro — on Node's
// own readline, so `npx naso-dev` installs nothing but itself. Arrow keys or j/k
// move, Enter answers, y/n answer a confirm directly, Ctrl+C or Escape cancels.
//
// Every prompt takes `input` and `output` streams, so a test drives the real
// prompt through a PassThrough instead of a pty. A stream that is not a TTY is
// read as keypresses all the same; raw mode is switched on only where it exists,
// and always switched back off.
//
// Not vendored: only the interactive setup asks anything. See vendorSources().

import { emitKeypressEvents } from 'node:readline';
import { plainStyle } from './lib.mjs';

/** What a prompt resolves to when the person cancelled. */
export const CANCEL = Symbol('naso.cancel');

export const isCancel = (value) => value === CANCEL;

const BAR = '│';

/**
 * Ask one question and redraw it on every key until it is answered.
 *
 * `render(state)` returns the frame's lines; `onKey(key, state)` returns 'submit',
 * 'cancel' or nothing. The final frame is drawn once more so the scrollback shows
 * the answer that was given, not the prompt as it stood one key earlier.
 */
function prompt({ input = process.stdin, output = process.stdout, render, onKey, state, result }) {
  return new Promise((resolve) => {
    let drawn = 0;
    const draw = (status) => {
      const lines = render(state, status);
      // Up to the first line of the previous frame, then clear to the end of the screen.
      if (drawn > 0) output.write(`\u001b[${drawn}A\r\u001b[J`);
      output.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };

    const raw = Boolean(input.isTTY && typeof input.setRawMode === 'function');
    emitKeypressEvents(input);
    if (raw) input.setRawMode(true);
    output.write('\u001b[?25l'); // hide the cursor while the selection is the cursor

    const finish = (status, value) => {
      input.off('keypress', handle);
      if (raw) input.setRawMode(false);
      input.pause();
      draw(status);
      output.write('\u001b[?25h');
      resolve(value);
    };

    function handle(text, key = {}) {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return finish('cancel', CANCEL);
      const outcome = onKey(key.name ?? text, state);
      if (outcome === 'submit') return finish('submit', result(state));
      if (outcome === 'cancel') return finish('cancel', CANCEL);
      draw('active');
    }

    input.on('keypress', handle);
    input.resume();
    draw('active');
  });
}

/** The question line, marked by how the prompt stands. */
function header(paint, message, status) {
  const mark = status === 'submit' ? paint.green('◇') : status === 'cancel' ? paint.red('■') : paint.cyan('◆');
  return [paint.gray(BAR), `${mark}  ${message}`];
}

const UP = new Set(['up', 'left', 'k']);
const DOWN = new Set(['down', 'right', 'j', 'tab']);

/**
 * One choice from a list.
 *
 * @param {{ message: string, options: { value: string, label: string, hint?: string }[],
 *   initialValue?: string, style?: object, input?: object, output?: object }} config
 */
export function select({ message, options, initialValue, style = plainStyle, ...io }) {
  const start = Math.max(0, options.findIndex((option) => option.value === initialValue));
  return prompt({
    ...io,
    state: { cursor: start },
    result: (state) => options[state.cursor].value,
    onKey(key, state) {
      if (key === 'return' || key === 'enter') return 'submit';
      if (UP.has(key)) state.cursor = (state.cursor - 1 + options.length) % options.length;
      if (DOWN.has(key)) state.cursor = (state.cursor + 1) % options.length;
    },
    render(state, status) {
      const lines = header(style, message, status);
      const chosen = options[state.cursor];
      if (status === 'submit') return [...lines, `${style.gray(BAR)}  ${style.dim(chosen.label)}`];
      if (status === 'cancel') return [...lines, `${style.gray(BAR)}  ${style.dim(chosen.label)}`, style.gray(BAR)];
      for (const option of options) {
        const hint = option.hint ? ` ${style.dim(`(${option.hint})`)}` : '';
        lines.push(
          option === chosen
            ? `${style.cyan(BAR)}  ${style.green('●')} ${option.label}${hint}`
            : `${style.cyan(BAR)}  ${style.dim('○')} ${style.dim(option.label)}`,
        );
      }
      return [...lines, style.cyan('└')];
    },
  });
}

/** Yes or no. `y` and `n` answer at once; arrows move between them and Enter answers. */
export function confirm({ message, initialValue = true, style = plainStyle, ...io }) {
  return prompt({
    ...io,
    state: { value: Boolean(initialValue) },
    result: (state) => state.value,
    onKey(key, state) {
      if (key === 'y') return (state.value = true), 'submit';
      if (key === 'n') return (state.value = false), 'submit';
      if (key === 'return' || key === 'enter') return 'submit';
      if (UP.has(key) || DOWN.has(key)) state.value = !state.value;
    },
    render(state, status) {
      const lines = header(style, message, status);
      const answer = state.value ? 'Yes' : 'No';
      if (status !== 'active') return [...lines, `${style.gray(BAR)}  ${style.dim(answer)}`];
      const yes = state.value ? `${style.green('●')} Yes` : `${style.dim('○ Yes')}`;
      const no = state.value ? `${style.dim('○ No')}` : `${style.green('●')} No`;
      return [...lines, `${style.cyan(BAR)}  ${yes} ${style.dim('/')} ${no}`, style.cyan('└')];
    },
  });
}

/** A titled aside between questions. */
export function note(message, title, { style = plainStyle, output = process.stdout } = {}) {
  const body = String(message).split('\n').map((line) => `${style.gray(BAR)}  ${line}`);
  output.write(`${[style.gray(BAR), `${style.green('◇')}  ${title}`, ...body].join('\n')}\n`);
}

/** The last line of a run. */
export function outro(message, { style = plainStyle, output = process.stdout } = {}) {
  output.write(`${style.gray(BAR)}\n${style.gray('└')}  ${message}\n\n`);
}
