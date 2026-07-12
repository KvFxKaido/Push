// smoke.ts — the adopt-gate for Rezi, mirroring ../opentui-spike/smoke.ts:
// does the native C engine ("Zireael", N-API via @rezi-ui/native) load on
// Node — the runtime `./push` actually ships on — and does the TS core
// honor the decision doc's CellWidth contract (wide glyphs, ZWJ, combining)?
//
// Run: npm run smoke:node   (tsx/Node)
//      npm run smoke:bun    (Bun, control)
//
// Interpretation:
//   - "NATIVE ENGINE LOADED"  -> N-API binding works on this runtime; the
//     OpenTUI disqualifier (Bun-only native core) does NOT apply to Rezi.
//   - dlopen / platform error -> prebuilt binary missing/broken here.
//   - The width probes are independent: they exercise the pure-TS side
//     (layout/textMeasure) that Push's compositor contract cares about.

const runtime = (globalThis as any).Bun
  ? `bun ${(globalThis as any).Bun.version}`
  : `node ${process.version}`;

async function probeCore() {
  const core: any = await import('@rezi-ui/core');
  const keys = Object.keys(core);
  console.log(`[core]  imported @rezi-ui/core (${keys.length} exports) on ${runtime}`);
  // The contract-relevant surface for Push's requirement (panes/modals/mouse):
  for (const name of [
    'createApp',
    'createTestRenderer',
    'hitTestLayers',
    'pushLayer',
    'popLayer',
    'useModalStack',
    'measureTextCells',
  ]) {
    console.log(`[core]  ${typeof core[name] === 'function' ? '✅' : '❌'} ${name}`);
  }
  return core;
}

function probeWidthContract(core: any) {
  // The decision doc's CellWidth day-one contract, as data. Expected column
  // widths per grapheme cluster; a miss here means corrupted frames later.
  const cases: Array<[string, string, number]> = [
    ['ascii', 'a', 1],
    ['CJK wide', '中', 2],
    ['emoji', '👍', 2],
    ['ZWJ family (one grapheme)', '👩‍👩‍👧‍👦', 2],
    ['combining mark (e + U+0301)', 'é', 1],
  ];
  let pass = true;
  for (const [label, text, expected] of cases) {
    const got = core.measureTextCells(text);
    const ok = got === expected;
    pass &&= ok;
    console.log(
      `[width] ${ok ? '✅' : '❌'} ${label}: measureTextCells(${JSON.stringify(text)}) = ${got} (want ${expected})`,
    );
  }
  return pass;
}

async function probeNative() {
  const native: any = await import('@rezi-ui/native');
  console.log(`[nat ]  imported @rezi-ui/native on ${runtime}`);
  if (typeof native.engineCreate !== 'function') {
    throw new Error('engineCreate missing — API drift');
  }
  // engineCreate dlopen()s the platform .node binary, then probes the
  // terminal (DA1/capability queries). Return-value semantics (ZrResult in
  // @rezi-ui/core/dist/abi.d.ts): >= 0 is an engine id; -6 ERR_PLATFORM is
  // the expected headless result (no TTY); -1 ERR_INVALID_ARGUMENT is what
  // a dumb PTY (`script -qec`) produces — the engine boots, sends its
  // probes, and gets no answers. Neither is a native-load failure: reaching
  // a ZrResult at all proves the N-API binding loaded. A dlopen/platform
  // *throw* is the real fail. For the full boot, run probe-tty.mjs inside a
  // real terminal emulator (verified: id >= 0 + caps incl. mouse on
  // Windows Terminal/WSL, Node 22).
  const id = native.engineCreate({});
  if (id >= 0) {
    console.log(`\n==> NATIVE ENGINE LOADED on ${runtime} — engineCreate returned id ${id}.`);
    native.engineDestroy(id);
  } else {
    console.log(
      `\n==> NATIVE BINDING LOADED on ${runtime} — engineCreate returned ZrResult ${id} ` +
        `(expected without a real TTY; run probe-tty.mjs in a terminal for the full boot).`,
    );
  }
}

(async () => {
  console.log(`\n=== Rezi native-load + width-contract smoke — runtime: ${runtime} ===`);
  let widthOk = false;
  try {
    const core = await probeCore();
    widthOk = probeWidthContract(core);
  } catch (e: any) {
    console.log(`[core]  FAILED: ${e?.message ?? e}`);
    process.exit(1);
  }
  try {
    await probeNative();
  } catch (e: any) {
    console.log(`\n==> NATIVE ENGINE FAILED on ${runtime}:`);
    console.log(`    ${e?.message ?? e}`);
    process.exit(1);
  }
  process.exit(widthOk ? 0 : 2);
})();
