#!/usr/bin/env node
/* diagnostic: for each accepted line, what fraction of steady frames is the
   motion band "hot"? A true end-wall crossing line is hot only briefly
   (dive/turn/touch); a line running ALONG the swim path is hot most of the
   clip. Used to tune the duty-cycle reject in detect-lines.js. */
import { detectLines, DEFAULTS } from '../../src/detect-lines.js';
import { decodeGray } from './decode.mjs';

const clips = [
  '/Users/User/Downloads/files/IMG_7199.mov',
  '/Users/User/Downloads/files/IMG_7464.mov',
  '/Users/User/Downloads/files/IMG_7465.mov',
  '/Users/User/Downloads/files/IMG_7466.mov',
];

for (const clip of clips) {
  const F = decodeGray(clip, { width: 240 });
  const r = detectLines(F, { __debugBands: true });
  const name = clip.split('/').pop();
  console.log(`\n${name}`);
  if (!r._debug) { console.log('  (no debug)'); continue; }
  for (const b of r._debug.bands) {
    console.log(`  ${b.role.padEnd(6)} duty ${(b.duty * 100).toFixed(0).padStart(3)}%  fill ${(b.fill * 100).toFixed(0).padStart(3)}%  span ${b.spanLen.toFixed(1)}s  base ${b.baseline.toFixed(1)}  peak ${b.peak.toFixed(1)}  edgePk ${(b.edgePeak ?? -1).toFixed(1)}  interiorPk ${(b.interiorPeak ?? -1).toFixed(1)}  rises ${b.riseCount}`);
  }
}
