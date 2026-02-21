/**
 * format.mjs — ANSI color, semantic styles, and spinner.
 * Zero dependencies. Follows no-color.org and force-color.org standards.
 */

const hasColor = !process.env.NO_COLOR &&
  (!!process.env.FORCE_COLOR || (process.stdout?.isTTY ?? false));

/**
 * Create a formatter with explicit color on/off.
 * Factory pattern lets tests control color without environment hacks.
 */
export function createFormatter(colorEnabled) {
  const wrap = (open, close) =>
    colorEnabled
      ? (text) => `\x1b[${open}m${text}\x1b[${close}m`
      : (text) => String(text);

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
    error: (text) => bold(red(text)),
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

  #colorEnabled;
  #timer = null;
  #frameIdx = 0;
  #text = '';

  constructor(colorEnabled = hasColor) {
    this.#colorEnabled = colorEnabled;
  }

  get active() {
    return this.#timer !== null;
  }

  start(text = '') {
    if (this.#timer) this.stop();
    if (!this.#colorEnabled) return; // no-op on non-TTY
    this.#text = text;
    this.#frameIdx = 0;
    this.#render();
    this.#timer = setInterval(() => this.#render(), Spinner.INTERVAL);
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    // Clear spinner line
    const clearLen = Spinner.FRAMES[0].length + 1 + this.#text.length + 5;
    process.stdout.write(`\r${' '.repeat(clearLen)}\r`);
  }

  #render() {
    const frame = Spinner.FRAMES[this.#frameIdx % Spinner.FRAMES.length];
    this.#frameIdx++;
    process.stdout.write(`\r${frame} ${this.#text}`);
  }
}

export { hasColor };
