#!/usr/bin/env node
/* dump the near-line motion band as a coarse ASCII sparkline with ground-truth
   markers, to see whether the corner-shot water edge behaves like a wall the
   swimmer crosses (two spikes, quiet between) or one they swim along. */
import { detectLines } from '../../src/detect-lines.js';
import { decodeGray } from './decode.mjs';

const GT = {
  'IMG_7199.mov': { dive: 1.05, touch: null },
  'IMG_7464.mov': { dive: 12.75, touch: 25.85 },
  'IMG_7465.mov': { dive: 2.234, touch: 15.20 },
  'IMG_7466.mov': { dive: 12.50, touch: 25.52 },
};

for (const [f, gt] of Object.entries(GT)) {
  const F = decodeGray(`/Users/User/Downloads/files/${f}`, { width: 240 });
  const r = detectLines(F, { __dumpSeries: true });
  console.log(`\n${f}   dive=${gt.dive} touch=${gt.touch}`);
  if (!r._series) { console.log('  ', r.diagnostics?.reason || 'no series'); continue; }
  for (const s of r._series) {
    if (!s || !s.series) continue;
    const N = 100;
    const buckets = new Float32Array(N);
    for (let i = 0; i < s.series.length; i++) {
      const b = Math.min(N - 1, Math.floor((i / s.series.length) * N));
      if (s.series[i] > buckets[b]) buckets[b] = s.series[i];
    }
    const max = Math.max(...buckets);
    const ramp = ' .:-=+*#%@';
    let line = '';
    for (let b = 0; b < N; b++) line += ramp[Math.min(9, Math.floor((buckets[b] / max) * 9))];
    console.log(`  [${s.role}] y~${s.meanY.toFixed(0)} dur ${F.duration.toFixed(1)}s  max ${max.toFixed(1)}`);
    console.log(`   ${line}`);
    const mark = (t, c) => t == null ? null : Math.floor((t / F.duration) * N);
    let m = ' '.repeat(N).split('');
    const md = mark(gt.dive); if (md != null && md < N) m[md] = 'D';
    const mt = mark(gt.touch); if (mt != null && mt < N) m[mt] = 'T';
    console.log(`   ${m.join('')}`);
  }
}
