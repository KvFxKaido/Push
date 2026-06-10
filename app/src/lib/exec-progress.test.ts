import { describe, expect, it } from 'vitest';
import { createExecProgressTail } from './exec-progress';

function collect() {
  const lines: string[] = [];
  return { lines, onTail: (l: string) => lines.push(l) };
}

describe('createExecProgressTail', () => {
  it('emits the last non-empty line of a chunk', () => {
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, now: () => 1000 });
    tail({ stdout: 'one\ntwo\nthree\n', stderr: '' });
    expect(lines).toEqual(['three']);
  });

  it('carries a partial line across chunk boundaries', () => {
    let t = 0;
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, now: () => (t += 1000) });
    tail({ stdout: 'PASS src/a.test.ts\n✓ long test na', stderr: '' });
    tail({ stdout: 'me finished\n', stderr: '' });
    expect(lines[0]).toBe('✓ long test na'); // best available after chunk 1
    expect(lines[1]).toBe('✓ long test name finished'); // whole line once completed
  });

  it('treats carriage returns as line breaks (progress-bar rewrites)', () => {
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, now: () => 1000 });
    tail({ stdout: 'progress 10%\rprogress 50%\rprogress 90%', stderr: '' });
    expect(lines).toEqual(['progress 90%']);
  });

  it('strips ANSI escape sequences', () => {
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, now: () => 1000 });
    tail({ stdout: '\u001b[32m✓ 113 passed\u001b[0m\n', stderr: '' });
    expect(lines).toEqual(['✓ 113 passed']);
  });

  it('throttles emissions and never re-emits an unchanged line', () => {
    let t = 1000;
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, throttleMs: 500, now: () => t });
    tail({ stdout: 'a\n', stderr: '' }); // emit 'a'
    t = 1200;
    tail({ stdout: 'b\n', stderr: '' }); // inside the window — skipped
    t = 1600;
    tail({ stdout: 'c\n', stderr: '' }); // emit 'c'
    t = 3500;
    tail({ stdout: '\n', stderr: '' }); // tail still 'c' — deduped
    expect(lines).toEqual(['a', 'c']);
  });

  it('truncates long lines with an ellipsis', () => {
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, maxChars: 10, now: () => 1000 });
    tail({ stdout: 'abcdefghijklmnop\n', stderr: '' });
    expect(lines).toEqual(['abcdefghi…']);
  });

  it('includes stderr content', () => {
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, now: () => 1000 });
    tail({ stdout: '', stderr: 'npm warn deprecated something\n' });
    expect(lines).toEqual(['npm warn deprecated something']);
  });

  it('emits nothing for whitespace-only output', () => {
    const { lines, onTail } = collect();
    const tail = createExecProgressTail({ onTail, now: () => 1000 });
    tail({ stdout: '\n\n  \n', stderr: '' });
    expect(lines).toEqual([]);
  });
});
