// smoke.ts — the one question that decides adopt-vs-build:
// does @opentui/core load its native Zig core on Node (not just Bun)?
//
// Run: npm run smoke:node   (tsx/Node)
//      npm run smoke:bun    (Bun, control)
//
// Interpretation:
//   - "NATIVE CORE LOADED" line  -> OpenTUI works on this runtime. Adopt is viable.
//   - dlopen / platform-unsupported / napi error -> native core failed to load here.
//   - Yoga probe is independent: if Yoga loads but the renderer doesn't, that still
//     tells us the pure-TS layout engine (Option B) has its layout dependency on Node.

const runtime = (globalThis as any).Bun
  ? `bun ${(globalThis as any).Bun.version}`
  : `node ${process.version}`;

async function probeYoga() {
  try {
    const core: any = await import('@opentui/core');
    if (!core.Yoga) return console.log(`[yoga]  no Yoga export found`);
    // Yoga is exported as a namespace; presence + a Config/Node factory is enough.
    const hasFactory =
      typeof core.Yoga.Node?.create === 'function' ||
      typeof core.Yoga.Node?.createDefault === 'function';
    console.log(`[yoga]  Yoga export present on ${runtime} (node factory: ${hasFactory})`);
  } catch (e: any) {
    console.log(`[yoga]  FAILED: ${e?.message ?? e}`);
  }
}

async function probeNative() {
  const core: any = await import('@opentui/core');
  console.log(`[core]  imported @opentui/core (${Object.keys(core).length} exports) on ${runtime}`);
  if (typeof core.createCliRenderer !== 'function') {
    console.log(`[core]  createCliRenderer not a function — API drift`);
    return;
  }
  // Renderer creation is what pulls in and dlopen()s the Zig core. Race it against a
  // timeout: a hang means the native core loaded and the render loop started (it just
  // wants a real TTY). A throw with a dlopen/platform message means native load failed.
  const create = core.createCliRenderer({ exitOnCtrlC: false }).then((r: any) => {
    console.log(`\n==> NATIVE CORE LOADED on ${runtime} — createCliRenderer resolved.`);
    try {
      r?.destroy?.() ?? r?.stop?.();
    } catch {}
    return 'resolved';
  });
  const timeout = new Promise<string>((res) => setTimeout(() => res('timeout'), 5000));
  const outcome = await Promise.race([create, timeout]);
  if (outcome === 'timeout') {
    console.log(
      `\n==> NATIVE CORE LOADED on ${runtime} — renderer started (timed out waiting for TTY, which is the pass signal in a non-terminal).`,
    );
  }
}

(async () => {
  console.log(`\n=== OpenTUI native-load smoke test — runtime: ${runtime} ===`);
  await probeYoga();
  try {
    await probeNative();
  } catch (e: any) {
    console.log(`\n==> NATIVE CORE FAILED on ${runtime}:`);
    console.log(`    ${e?.message ?? e}`);
    console.log(
      (e?.stack ?? '')
        .split('\n')
        .slice(1, 6)
        .map((l: string) => '    ' + l.trim())
        .join('\n'),
    );
    process.exit(1);
  }
  process.exit(0);
})();
