// smoke.ts — the adopt-gate for Glyph, mirroring ../rezi-spike/smoke.ts:
// pure-TS React-reconciler TUI with a cell framebuffer + damage diffing —
// the closest external analog to the decision doc's own compositor design.
//
// Run: npm run smoke:node   (tsx/Node)
//      npm run smoke:bun    (Bun, control)
//
// Empirical findings this smoke encodes (2026-07-12, glyph 0.2.10):
//   - React 19 REQUIRED. The peer range claims ^18 || ^19, but the pinned
//     react-reconciler@0.31 reads React 19 internals (ReactSharedInternals.S)
//     and crashes AT IMPORT on React 18.3 — the 18 half of the peer range is
//     untested upstream. This spike pins react@^19.
//   - Mouse support EXISTS despite being absent from the README: useMouse is
//     exported, and render() enables SGR mouse tracking (?1000/?1003/?1006)
//     with button/wheel/mousedown handling in dist.
//   - Width contract passes at the STRING level (string-width v7 under the
//     hood): CJK=2, ZWJ family=one grapheme of 2, combining=1. Whether the
//     cell framebuffer honors these during rasterization is a stress-phase
//     question (see ../STRESS.md), not settled here.
//   - Headless render works (alt-screen + kitty keyboard + mouse modes, then
//     clean teardown) — but paints two identical full frames for one static
//     scene, so the damage diff may not engage off-TTY. Stress-phase item.

const runtime = (globalThis as any).Bun
  ? `bun ${(globalThis as any).Bun.version}`
  : `node ${process.version}`;

async function probeCore() {
  const glyph: any = await import('@semos-labs/glyph');
  console.log(
    `[core]  imported @semos-labs/glyph (${Object.keys(glyph).length} exports) on ${runtime}`,
  );
  for (const name of ['render', 'Portal', 'DialogHost', 'useMouse', 'useFocus', 'ttyStringWidth']) {
    console.log(`[core]  ${typeof glyph[name] === 'function' ? '✅' : '❌'} ${name}`);
  }
  return glyph;
}

function probeWidthContract(glyph: any) {
  const cases: Array<[string, string, number]> = [
    ['ascii', 'a', 1],
    ['CJK wide', '中', 2],
    ['emoji', '👍', 2],
    ['ZWJ family (one grapheme)', '👩‍👩‍👧‍👦', 2],
    ['combining mark (e + U+0301)', 'é', 1],
  ];
  let pass = true;
  for (const [label, text, expected] of cases) {
    const got = glyph.ttyStringWidth(text);
    const ok = got === expected;
    pass &&= ok;
    console.log(
      `[width] ${ok ? '✅' : '❌'} ${label}: ttyStringWidth(${JSON.stringify(text)}) = ${got} (want ${expected})`,
    );
  }
  return pass;
}

async function probeRender(glyph: any) {
  const React: any = (await import('react')).default;
  // Rendering writes ANSI to stdout; that's fine for a smoke — the pass
  // signal is a clean mount/unmount without throwing, TTY or not.
  const app = glyph.render(React.createElement(glyph.Text, null, 'glyph smoke 中 👍'));
  if (!app || typeof app.unmount !== 'function') {
    throw new Error('render() did not return an { unmount } handle — API drift');
  }
  await new Promise((res) => setTimeout(res, 800));
  app.unmount();
  console.log(
    `\n==> RENDER MOUNT/UNMOUNT OK on ${runtime} (pure TS — no native binding involved).`,
  );
}

(async () => {
  console.log(`\n=== Glyph import + width-contract + render smoke — runtime: ${runtime} ===`);
  let widthOk = false;
  try {
    const glyph = await probeCore();
    widthOk = probeWidthContract(glyph);
    await probeRender(glyph);
  } catch (e: any) {
    console.log(`\n==> SMOKE FAILED on ${runtime}: ${e?.message ?? e}`);
    process.exit(1);
  }
  process.exit(widthOk ? 0 : 2);
})();
