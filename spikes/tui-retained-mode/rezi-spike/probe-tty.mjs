// probe-tty.mjs — run INSIDE a real terminal emulator (one that answers
// DA/capability queries). `script -qec` is not enough: the engine boots,
// sends its probe sequences, gets no answers, and bails. See smoke.ts for
// the headless/N-API half of the gate.
import { engineCreate, engineDestroy, engineGetCaps } from '@rezi-ui/native';

const id = engineCreate({});
// Leave the alt screen before printing so the result survives teardown.
if (id >= 0) {
  let caps = null;
  try {
    caps = engineGetCaps?.(id);
  } catch {}
  engineDestroy(id);
  console.log(`REZI_TTY_PROBE ok id=${id} caps=${JSON.stringify(caps)}`);
} else {
  console.log(`REZI_TTY_PROBE fail code=${id}`);
}
process.exit(id >= 0 ? 0 : 1);
