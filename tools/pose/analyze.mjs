/* Read a pose CSV, build confidence-weighted trajectories, self-calibrate the
   pool long axis by PCA, and read the dive off the ankle trajectory.
   Usage: node tools/pose/analyze.mjs <poseCsv> <fps> <diveGT_s> [touchGT_s] */
import fs from 'node:fs';

const [csvPath, fpsArg, diveGT, touchGT] = process.argv.slice(2);
const fps = Number(fpsArg);
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const v = l.split(',');
  const o = {};
  header.forEach((h, i) => (o[h] = Number(v[i])));
  return o;
});

const kpNames = ['nose','left_eye','right_eye','left_ear','right_ear','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle'];
const CONF = 0.2;

// per-frame: chosen keypoint groups
function grp(r, names) {
  let x = 0, y = 0, w = 0;
  for (const n of names) {
    const s = r[n + '_s'];
    if (s > CONF) { x += r[n + '_x'] * s; y += r[n + '_y'] * s; w += s; }
  }
  return w > 0 ? { x: x / w, y: y / w, w } : null;
}

const series = rows.map(r => ({
  f: r.frame,
  t: (r.frame - 1) / fps,
  ankle: grp(r, ['left_ankle', 'right_ankle']),
  hip: grp(r, ['left_hip', 'right_hip']),
  body: grp(r, kpNames),
  score: r.score,
}));

// interpolate a channel across gaps, drop leading/trailing missing
function fill(getter) {
  const idx = [], val = [];
  series.forEach((s, i) => { const p = getter(s); if (p) { idx.push(i); val.push(p); } });
  if (idx.length < 3) return null;
  const out = new Array(series.length).fill(null);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    for (let i = a; i <= b; i++) {
      const f = (i - a) / (b - a);
      out[i] = { x: val[k].x + f * (val[k + 1].x - val[k].x), y: val[k].y + f * (val[k + 1].y - val[k].y) };
    }
  }
  return out;
}

const ankleF = fill(s => s.ankle);
const bodyF = fill(s => s.body);

// PCA long axis over body points
function pca(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx*dx; sxy += dx*dy; syy += dy*dy; }
  sxx/=n; sxy/=n; syy/=n;
  const tr = sxx + syy, det = sxx*syy - sxy*sxy;
  const l1 = tr/2 + Math.sqrt(Math.max(0, tr*tr/4 - det));
  let ax = sxy, ay = l1 - sxx;
  if (Math.abs(sxy) < 1e-9) { ax = sxx >= syy ? 1 : 0; ay = sxx >= syy ? 0 : 1; }
  const m = Math.hypot(ax, ay); ax/=m; ay/=m;
  return { mx, my, ax, ay };
}
const axis = pca(bodyF.filter(Boolean));
const proj = p => (p.x - axis.mx) * axis.ax + (p.y - axis.my) * axis.ay;

// smooth
function smooth(arr, win) {
  const k = Math.max(1, win | 1);
  const h = k >> 1;
  return arr.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) { if (arr[j] != null) { s += arr[j]; c++; } }
    return c ? s / c : null;
  });
}

const ankleY = smooth(ankleF.map(p => p ? p.y : null), 5);
const ankleX = smooth(ankleF.map(p => p ? p.x : null), 5);
const bodyPos = smooth(bodyF.map(p => p ? proj(p) : null), 5);

/* dive = the ankle keypoints leave the deck line and never come back.
   The swimmer shuffles their feet on the blocks before the dive, so the FIRST
   downward blip is not the dive. Instead: find the last frame the ankles are at
   deck level that is followed by a sustained departure (ankles drop far below the
   deck line, or pose tracking collapses because the swimmer has hit the water)
   within a short window. */
/* The swimmer is fully extended, feet highest, just before entering the water;
   after entry pose tracking collapses. The global minimum of ankle-y is that
   apex, so the dive must be at or before it. Everything after is post-entry
   noise (the model re-locking onto a splash near the deck line) and is ignored. */
let apex = 0, apexV = Infinity;
ankleY.forEach((v, i) => { if (v != null && v < apexV) { apexV = v; apex = i; } });
const preY = ankleY.slice(0, apex + 1).filter(v => v != null).slice().sort((a, b) => a - b);
const deckBase = preY.length ? preY[Math.floor(0.55 * preY.length)] : apexV; // feet rest on the deck most of the time
const scoreArr = series.map(s => s.score);
const W = Math.round(0.4 * fps);        // departure must show within ~0.4 s
const DEEP = 45;                        // px below deck that counts as "gone"
let dive = null;
for (let i = apex - 2; i >= 2; i--) {
  if (ankleY[i] == null || ankleY[i] < deckBase - 20) continue; // must still be on deck
  let gone = false;
  for (let j = i + 2; j <= Math.min(apex, i + W); j++) {
    if (ankleY[j] != null && ankleY[j] < deckBase - DEEP) { gone = true; break; }
  }
  if (gone) { dive = i + 1; break; }   // feet have left by the next frame
}
if (dive == null) { // fallback: steepest sustained descent
  let best = 0, bi = null;
  for (let i = 3; i < ankleY.length - 3; i++) {
    if (ankleY[i - 3] == null || ankleY[i + 3] == null) continue;
    const d = ankleY[i + 3] - ankleY[i - 3];
    if (d < best) { best = d; bi = i; }
  }
  dive = bi;
}

const diveFrame = dive != null ? series[dive].f : null;
const diveT = dive != null ? series[dive].t : null;
const gtFrame = diveGT ? Math.round(Number(diveGT) * fps) + 1 : null;

console.log(`file ${csvPath}`);
console.log(`fps ${fps.toFixed(3)}  axis (${axis.ax.toFixed(2)},${axis.ay.toFixed(2)})  deckBaseY ${deckBase?.toFixed(0)}`);
console.log(`DIVE  detected frame ${diveFrame}  t=${diveT?.toFixed(3)}s`);
if (gtFrame) console.log(`      GT frame ${gtFrame} (t=${Number(diveGT).toFixed(3)}s)  error ${diveFrame - gtFrame} frames`);
console.log('\nframe  t     score ankleX ankleY bodyPos');
series.forEach((s, i) => {
  console.log(
    `${String(s.f).padStart(4)}  ${s.t.toFixed(2)}  ${s.score.toFixed(2)}  ` +
    `${ankleX[i] != null ? ankleX[i].toFixed(0).padStart(5) : '   . '} ` +
    `${ankleY[i] != null ? ankleY[i].toFixed(0).padStart(5) : '   . '} ` +
    `${bodyPos[i] != null ? bodyPos[i].toFixed(0).padStart(6) : '    . '}`);
});
