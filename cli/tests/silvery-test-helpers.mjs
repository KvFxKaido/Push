import assert from 'node:assert/strict';

/**
 * Replays all cursor-addressed output written by a fullscreen Silvery fixture.
 * Keeping this in one place matters: CI can select a different non-TTY lane,
 * while these fixtures deliberately exercise the real TTY diff protocol.
 */
export function createVirtualTerminalFrameReader({ Silvery, stdout, columns, rows }) {
  const readTerminal = () => {
    const terminal = new Silvery.VirtualTerminal(columns, rows);
    terminal.applyAnsi(stdout.bytes);
    return terminal;
  };

  const readRows = () => {
    const terminal = readTerminal();
    return Array.from({ length: rows }, (_, y) =>
      Array.from({ length: columns }, (_, x) => terminal.getChar(x, y) || ' ')
        .join('')
        .trimEnd(),
    );
  };

  return { readRows, readTerminal };
}

export async function waitForVirtualTerminalFrame(
  readRows,
  predicate,
  { attempts = 300, intervalMs = 10 } = {},
) {
  let frameRows = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    frameRows = readRows();
    if (predicate(frameRows)) return frameRows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return frameRows;
}

/**
 * Applies full and incremental ANSI writes to one terminal, then compares the
 * replayed cells and styles with Silvery's canonical target buffer.
 */
export function createVirtualTerminalReplay({ Silvery, columns, rows }) {
  const terminal = new Silvery.VirtualTerminal(columns, rows);
  return {
    apply(ansi) {
      terminal.applyAnsi(ansi);
    },
    assertMatches(buffer, message = 'incremental ANSI replay diverged from the render buffer') {
      assert.deepEqual(terminal.compareToBuffer(buffer), [], `${message} (characters)`);
      assert.deepEqual(terminal.compareStylesToBuffer(buffer), [], `${message} (styles)`);
    },
  };
}
