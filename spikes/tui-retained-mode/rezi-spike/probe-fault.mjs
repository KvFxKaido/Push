// probe-fault.mjs — minimal repro hunt for the scene-6 silent death: a bare
// non-modal ui.layer with backdrop:'dim' faults the app, and run() RESOLVES
// CLEANLY (no rejection, no stderr, exit 0) — the app just vanishes.
// Run in a real terminal:  VARIANT=dim node probe-fault.mjs
//                          VARIANT=none node probe-fault.mjs
// A variant that "exits" in <1s died on first paint; surviving to the 2.5s
// self-stop means that variant is fine. Elapsed time printed on exit.
import { ui } from '@rezi-ui/core';
import { createNodeApp } from '@rezi-ui/node';

const variant = process.env.VARIANT ?? 'dim';
const started = Date.now();

const plainBox = () => ui.box({ border: 'double', p: 1 }, [ui.text('layer content')]);
const bg = () => ui.column({}, [ui.text('background row 1'), ui.text('background row 2')]);

/** Variant matrix — each isolates one suspect from scene 6's tree. */
const VIEWS = {
  // center alone, no layers at all — is ui.center the killer?
  'center-only': () => ui.column({ gap: 1 }, [ui.text(variant), ui.center({}, [plainBox()])]),
  // bare layer, plain box content (no center), no backdrop
  'layer-plain-none': () =>
    ui.column({ gap: 1 }, [
      ui.text(variant),
      ui.layers([bg(), ui.layer({ id: 'p', modal: false, content: plainBox() })]),
    ]),
  // bare layer, plain box content, dim backdrop
  'layer-plain-dim': () =>
    ui.column({ gap: 1 }, [
      ui.text(variant),
      ui.layers([bg(), ui.layer({ id: 'p', modal: false, backdrop: 'dim', content: plainBox() })]),
    ]),
  // original scene-6 shape: layer + center + dim
  dim: () =>
    ui.column({ gap: 1 }, [
      ui.text(variant),
      ui.layers([
        bg(),
        ui.layer({ id: 'p', modal: false, backdrop: 'dim', content: ui.center({}, [plainBox()]) }),
      ]),
    ]),
  // layer + center, no dim
  none: () =>
    ui.column({ gap: 1 }, [
      ui.text(variant),
      ui.layers([bg(), ui.layer({ id: 'p', modal: false, content: ui.center({}, [plainBox()]) })]),
    ]),
};

const app = createNodeApp({ initialState: {} });
app.view(VIEWS[variant] ?? VIEWS.dim);

const done = app.run();
await app.ready();
const stopper = setTimeout(() => {
  try {
    void app.stop();
  } catch {}
}, 2500);
try {
  await done;
} catch (e) {
  console.error(`VARIANT=${variant} REJECTED: ${e?.code ?? ''} ${e?.message ?? e}`);
  process.exit(1);
}
clearTimeout(stopper);
const elapsed = Date.now() - started;
console.error(
  `VARIANT=${variant} run() resolved after ${elapsed}ms — ${elapsed < 1500 ? 'DIED ON PAINT (silent fault)' : 'survived to self-stop'}`,
);
