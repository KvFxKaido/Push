// Public-API probe + standalone HitRegistry semantics (scene 9 core).
// Finding: TerminalBuffer is NOT exported from the npm barrel — buffer-level
// scenes run through the real pipeline instead (see stress-pipeline.mjs).
// Run: node stress-buffer.mjs
import * as S from 'silvery';

const found = (n) => typeof S[n] !== 'undefined';
console.log(
  '[api]',
  [
    'TerminalBuffer',
    'RenderBuffer',
    'writeTextToBuffer',
    'splitGraphemes',
    'graphemeWidth',
    'displayWidth',
    'HitRegistry',
    'VirtualTerminal',
    'renderString',
  ]
    .map((n) => `${n}=${found(n) ? 'Y' : 'n'}`)
    .join(' '),
);

let pass = 0,
  fail = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

// Width model sanity (public helpers)
check(
  'graphemeWidth(👩‍👩‍👧‍👦)=2',
  S.graphemeWidth('👩‍👩‍👧‍👦') === 2,
  String(S.graphemeWidth('👩‍👩‍👧‍👦')),
);
check(
  'splitGraphemes keeps cluster whole',
  S.splitGraphemes('👩‍👩‍👧‍👦x').length === 2,
  JSON.stringify(S.splitGraphemes('👩‍👩‍👧‍👦x')),
);
check('displayWidth(中)=2', S.displayWidth('中') === 2, String(S.displayWidth('中')));

// Scene 9 core: HitRegistry z semantics
{
  const r = new S.HitRegistry();
  r.register('under', {
    x: 0,
    y: 0,
    width: 10,
    height: 3,
    target: { type: 'node', nodeId: 'under' },
    zIndex: 0,
  });
  r.register('modal', {
    x: 2,
    y: 1,
    width: 5,
    height: 1,
    target: { type: 'node', nodeId: 'modal' },
    zIndex: 10,
  });
  const top = r.hitTest(4, 1),
    out = r.hitTest(0, 0);
  check('9 topmost z wins at overlap', top?.nodeId === 'modal', JSON.stringify(top));
  check('9 underlying hit outside modal', out?.nodeId === 'under', JSON.stringify(out));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
