#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   score-lines.mjs — run src/detect-lines.js against the four reference clips
   and print, per clip:
     - whether a usable wall line was found, where, and why / why not
     - frame error for dive / turn / touch against ground truth

   The four reference clips are CORNER shots.  detectLines is the "future
   reshoot" detector — it needs a long-side camera with both end walls in
   frame.  It is EXPECTED to report `unfound` here.  That expectation is the
   finding; this script documents it clip by clip.

   Usage:
     node tools/lines/score-lines.mjs                 # uses the package.json clip paths
     node tools/lines/score-lines.mjs /path/a.mov ... # explicit clips
     node tools/lines/score-lines.mjs --width 320     # decode resolution
   --------------------------------------------------------------------------- */

import { existsSync } from 'node:fs';
import { detectLines } from '../../src/detect-lines.js';
import { decodeGray } from './decode.mjs';

const FRAME = 1 / 30;

const GROUND_TRUTH = {
  IMG_7199: { dive: 1.05, turn: null, touch: null },
  IMG_7464: { dive: 12.75, turn: null, touch: 25.85 },
  IMG_7465: { dive: 2.234, turn: null, touch: 15.20 },
  IMG_7466: { dive: 12.50, turn: null, touch: 25.52 },
};

const DEFAULT_CLIPS = [
  '/Users/User/Downloads/files/IMG_7199.mov',
  '/Users/User/Downloads/files/IMG_7464.mov',
  '/Users/User/Downloads/files/IMG_7465.mov',
  '/Users/User/Downloads/files/IMG_7466.mov',
];

function baseName(p) {
  const b = p.split('/').pop().replace(/\.[^.]+$/, '');
  return b.replace(/ \(\d+\)$/, '');
}

const args = process.argv.slice(2);
let width = 240;
const wi = args.indexOf('--width');
if (wi !== -1) { width = +args[wi + 1]; args.splice(wi, 2); }
const clips = args.length ? args : DEFAULT_CLIPS;

const f = (x, d = 2) => (x == null ? '  -  ' : x.toFixed(d));
const fr = (dt) => (dt == null ? '  -  ' : (dt / FRAME).toFixed(1));

console.log(`\ndetect-lines.js  —  decode width ${width}px\n${'='.repeat(72)}`);

for (const clip of clips) {
  if (!existsSync(clip)) {
    console.log(`\n${clip}\n  SKIPPED — file not found`);
    continue;
  }
  const name = baseName(clip);
  const gt = GROUND_TRUTH[name] || { dive: null, turn: null, touch: null };

  let F;
  try {
    F = decodeGray(clip, { width });
  } catch (e) {
    console.log(`\n${name}\n  DECODE FAILED — ${e.message.split('\n')[0]}`);
    continue;
  }

  const t0 = Date.now();
  const r = detectLines(F, {});
  const ms = Date.now() - t0;

  console.log(`\n${name}   (${F.width}x${F.height}, ${F.count} frames, ${F.fps.toFixed(2)} fps, ${ms} ms)`);
  console.log('-'.repeat(72));

  const found = r.lines.length > 0;
  console.log(`  usable wall line found : ${found ? 'YES' : 'NO'}`);

  if (found) {
    for (const ln of r.lines) {
      console.log(
        `    [${ln.role}] ${ln.orientation} angle ${ln.angleDeg.toFixed(1)}deg  ` +
        `y~${ln.meanY.toFixed(0)}  votesNorm ${ln.votesNorm.toFixed(2)}  ` +
        `sideVar ${ln.sideVariance.map((x) => x.toFixed(1)).join('/')}  ` +
        `contrast ${ln.waterContrast.toFixed(2)}  ` +
        `endpoints (${ln.x1.toFixed(0)},${ln.y1.toFixed(0)})-(${ln.x2.toFixed(0)},${ln.y2.toFixed(0)})`
      );
    }
  }

  const d = r.diagnostics;
  if (d.steadySpan)
    console.log(`  steady window : ${f(d.steadySpan[0])}-${f(d.steadySpan[1])}s  (${d.steadyFrames} frames, camera moved ${(d.cameraMovedFrac * 100).toFixed(0)}%)`);
  if (d.reason) console.log(`  reason        : ${d.reason}`);

  if (d.candidates && d.candidates.length) {
    console.log('  Hough candidates (strongest first):');
    for (const c of d.candidates.slice(0, 8)) {
      console.log(`    angle ${c.angleDeg.toFixed(1).padStart(5)}deg  rho ${c.rho.toFixed(0).padStart(5)}  votes ${c.votes.toFixed(0).padStart(7)}  -> ${c.verdict}`);
    }
  }

  console.log('  events:');
  console.log(`    ${'event'.padEnd(7)} ${'gt'.padStart(8)} ${'got'.padStart(8)} ${'err(fr)'.padStart(9)}  uncert`);
  for (const ev of ['dive', 'turn', 'touch']) {
    const got = r[ev];
    const g = gt[ev];
    const err = g != null && got != null ? got - g : null;
    const u = r.uncertainty[ev];
    console.log(`    ${ev.padEnd(7)} ${f(g).padStart(8)} ${f(got).padStart(8)} ${fr(err).padStart(9)}  ${u == null ? '-' : '+/-' + (u * 1000).toFixed(0) + 'ms'}`);
  }
  if (r.unfound.length) console.log(`  unfound: ${r.unfound.join(', ')}`);
  if (r.notes.length) {
    console.log('  notes:');
    for (const n of r.notes) console.log(`    - ${n}`);
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log('Expected outcome on these four clips: no usable wall line (corner camera).');
console.log('See tools/lines/SYNTHETIC.md for the camera setup that makes it work,');
console.log('and `node tools/lines/synthetic-test.mjs` for the crossing-math proof.\n');
