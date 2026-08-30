#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   synthetic-test.mjs — prove the line-crossing math.

   detectLines returns `unfound` on the four real corner-shot clips (see
   score-lines.mjs) because their geometry is wrong, NOT because the crossing
   detector is broken.  This runs the SAME detectLines on a generated clip
   whose geometry cooperates (tools/lines/make-synthetic.mjs) and checks it
   recovers the known dive / turn / touch times.

   Exits non-zero if the math misses.
   --------------------------------------------------------------------------- */

import { existsSync } from 'node:fs';
import { detectLines } from '../../src/detect-lines.js';
import { decodeGray } from './decode.mjs';
import { makeSynthetic, SYNTH_PATH, GROUND_TRUTH } from './make-synthetic.mjs';

if (!existsSync(SYNTH_PATH)) {
  console.log('synthetic clip missing — generating it');
  makeSynthetic();
}

const F = decodeGray(SYNTH_PATH, { width: 320 });
console.log(`\nsynthetic-crossing.mp4  —  ${F.width}x${F.height}, ${F.count} frames, ${F.fps.toFixed(2)} fps\n`);

const r = detectLines(F, {});

console.log('lines:');
for (const ln of r.lines) {
  console.log(
    `  [${ln.role}] ${ln.orientation} angle ${ln.angleDeg.toFixed(1)}deg  y~${ln.meanY.toFixed(0)}  ` +
    `contrast ${ln.waterContrast.toFixed(1)}  band ${ln.bandBaseline?.toFixed(1)}->${ln.bandPeak?.toFixed(1)}`
  );
}
console.log('notes:');
for (const n of r.notes) console.log(`  - ${n}`);

const FRAME = 1 / F.fps;
const tol = { dive: 0.30, turn: 1.2, touch: 0.30 }; // seconds; turn is a plateau
const rows = [];
let ok = true;
for (const ev of ['dive', 'turn', 'touch']) {
  const got = r[ev];
  const gt = GROUND_TRUTH[ev];
  const err = got == null ? null : got - gt;
  const pass = got != null && Math.abs(err) <= tol[ev];
  if (!pass) ok = false;
  rows.push(
    `  ${ev.padEnd(6)} gt ${gt.toFixed(2)}s   got ${got == null ? ' none ' : got.toFixed(2) + 's'}   ` +
    `err ${err == null ? '  -  ' : (err >= 0 ? '+' : '') + err.toFixed(2) + 's (' + (err / FRAME).toFixed(1) + ' fr)'}   ` +
    `${pass ? 'PASS' : 'FAIL'}`
  );
}
console.log('\nevents:');
console.log(rows.join('\n'));
console.log(`\nuncertainty: dive +/-${(r.uncertainty.dive * 1000 || 0).toFixed(0)}ms  ` +
  `turn +/-${(r.uncertainty.turn * 1000 || 0).toFixed(0)}ms  touch +/-${(r.uncertainty.touch * 1000 || 0).toFixed(0)}ms`);

console.log(`\n${ok ? 'PASS — crossing math recovers all three events when the geometry cooperates.'
                    : 'FAIL — see above.'}\n`);
process.exit(ok ? 0 : 1);
