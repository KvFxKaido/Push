/**
 * format.ts — ANSI color, semantic styles, and spinner.
 * Zero dependencies. Follows no-color.org and force-color.org standards.
 */

import process from 'node:process';

const hasColor = !process.env.NO_COLOR &&
  (!!process.env.FORCE_COLOR || (process.stdout?.isTTY ?? false));

type StyleFn = (text: string) => string;

export interface Formatter {
  bold: StyleFn;
  dim: StyleFn;
  red: StyleFn;
  green: StyleFn;
  yellow: StyleFn;
  cyan: StyleFn;
  success: StyleFn;
  error: StyleFn;
  warn: StyleFn;
}

/**
 * Create a formatter with explicit color on/off.
 * Factory pattern lets tests control color without environment hacks.
 */
export function createFormatter(colorEnabled: boolean): Formatter {
  const wrap = (open: string, close: string): StyleFn =>
    colorEnabled
      ? (text: string) => `\x1b[${open}m${text}\x1b[${close}m`
      : (text: string) => String(text);

  const bold   = wrap('1', '22');
  const dim    = wrap('2', '22');
  const red    = wrap('31', '39');
  const green  = wrap('32', '39');
  const yellow = wrap('33', '39');
  const cyan   = wrap('36', '39');

  return {
    bold,
    dim,
    red,
    green,
    yellow,
    cyan,
    // Semantic aliases
    success: green,
    error: (text: string) => bold(red(text)),
    warn: yellow,
  };
}

/** Default formatter based on environment detection. */
export const fmt = createFormatter(hasColor);

/**
 * Braille spinner for tool-execution feedback.
 * No-op on non-TTY (no animation, no cursor movement).
 */
export class Spinner {
  static FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  static INTERVAL = 80;

  #colorEnabled: boolean;
  #timer: ReturnType<typeof setInterval> | null = null;
  #frameIdx = 0;
  #text = '';

  constructor(colorEnabled = hasColor) {
    this.#colorEnabled = colorEnabled;
  }

  get active(): boolean {
    return this.#timer !== null;
  }

  start(text = ''): void {
    if (this.#timer) this.stop();
    if (!this.#colorEnabled) return; // no-op on non-TTY
    this.#text = text;
    this.#frameIdx = 0;
    this.#render();
    this.#timer = setInterval(() => this.#render(), Spinner.INTERVAL);
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    // Clear spinner line
    const clearLen = Spinner.FRAMES[0].length + 1 + this.#text.length + 5;
    process.stdout.write(`\r${' '.repeat(clearLen)}\r`);
  }

  #render(): void {
    const frame = Spinner.FRAMES[this.#frameIdx % Spinner.FRAMES.length];
    this.#frameIdx++;
    process.stdout.write(`\r${frame} ${this.#text}`);
  }
}

export { hasColor };
