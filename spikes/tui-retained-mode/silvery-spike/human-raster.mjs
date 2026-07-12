// Scene 3 human raster pass — run in a REAL terminal (Windows Terminal, VS Code
// terminal, others). Self-scoring: silvery pads every row to the same width by
// ITS width model; your terminal renders by ITS OWN. If they agree, the right
// border is one straight vertical line. Any row whose │ is shifted = raster
// divergence for that cluster class. Press q to quit.
// Run: node human-raster.mjs
import React from 'react';
import * as S from 'silvery';

const h = React.createElement;

const ROWS = [
  ['control (ascii)', 'abc'],
  ['CJK', '中文'],
  ['combining é', 'café café'],
  ['emoji single', '🎉'],
  ['emoji VS16', '☺️'],
  ['skin tone', '👋🏽'],
  ['flag (RI pair)', '🇺🇸'],
  ['ZWJ family', '👩‍👩‍👧‍👦'],
  ['ZWJ + tone', '🧑🏽‍💻'],
];

function App() {
  const { exit } = S.useApp();
  S.useInput((input) => {
    if (input === 'q') exit();
  });
  return h(
    S.Box,
    { flexDirection: 'column' },
    h(S.Text, null, 'RIGHT BORDER MUST BE ONE STRAIGHT LINE — any shifted │ = raster divergence'),
    h(
      S.Box,
      { borderStyle: 'round', width: 36, flexDirection: 'column' },
      ...ROWS.map(([label, sample]) => h(S.Text, { key: label }, `${sample} ${label}`)),
    ),
    h(S.Text, { dimColor: true }, 'score into STRESS.md scene 3 — note terminal name + q to quit'),
  );
}

await S.render(h(App)).run();
