// Scene 14 live repro — run in a REAL terminal. Press b to make the component
// throw during re-render. Driven run predicts: NO error output, run() never
// settles, terminal left without cursor restore (zombie). Ctrl+C may still work
// via the signal handler; if the terminal is stuck afterward, run `reset`.
// Run: node human-fault.mjs
import React from 'react';
import * as S from 'silvery';

const h = React.createElement;

function App() {
  const [boom, setBoom] = React.useState(false);
  S.useInput((input) => {
    if (input === 'b') setBoom(true);
    if (input === 'q') process.exit(0);
  });
  if (boom) throw new Error('deliberate-fault (scene 14)');
  return h(S.Text, null, 'alive — press b to fault the render, q to quit');
}

const t0 = Date.now();
try {
  await S.render(h(App)).run();
  console.error(`[scene14] run() RESOLVED after ${Date.now() - t0}ms`);
} catch (e) {
  console.error(`[scene14] run() REJECTED (LOUD) after ${Date.now() - t0}ms: ${e?.message}`);
}
