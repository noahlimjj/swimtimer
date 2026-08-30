/* Offline pipeline simulation over dumped trajectories — fast _analyzeDive iteration.
   node tools/pose/_sim.mjs */
import fs from "node:fs";
import { _analyzeDive, _localizeDeck } from "../../src/dive-pose.js";

const clips = ["IMG_7199", "IMG_7464", "IMG_7465", "IMG_7466"];
const nearest = (arr, t) => arr.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a);

for (const name of clips) {
  const r = JSON.parse(fs.readFileSync(`tools/pose/out/traj_${name}.json`, "utf8"));
  const { fps, H, gtDive, dur } = r;

  // pass 0: localization (whole clip, ~1.3s)
  const deckEndT = _localizeDeck(r.loc, H, dur);
  if (deckEndT == null) { console.log(`${name}: localize -> null`); continue; }

  // pass 1: coarse — every 6th frame in [deckEndT-1.5, deckEndT+4.5]
  const cLo = Math.max(0, deckEndT - 1.5), cHi = deckEndT + 4.5;
  const inDense = (t) => t >= r.dense[0].t - 1e-6 && t <= r.dense[r.dense.length - 1].t + 1e-6;
  const coarse = [];
  for (let t = cLo; t <= cHi; t += 6 / fps) {
    if (!inDense(t)) continue;
    coarse.push(nearest(r.dense, t));
  }
  const cRes = _analyzeDive(dedupe(coarse), fps, H);
  const centreT = cRes ? cRes.t : deckEndT;

  // pass 2: fine — every frame in [centreT-0.7, centreT+1.3]
  const fLo = centreT - 0.7, fHi = centreT + 1.3;
  const fine = r.dense.filter((s) => s.t >= fLo - 1e-3 && s.t <= fHi + 1e-3);
  const merged = dedupe(coarse.filter((s) => s.t < fLo - 1e-3 || s.t > fHi + 1e-3).concat(fine))
    .sort((a, b) => a.t - b.t);

  const res = _analyzeDive(merged, fps, H);
  const det = res ? res.t : null;
  const err = det == null ? null : Math.round((det - gtDive) * fps);
  console.log(
    `${name}: deckEndT=${deckEndT.toFixed(2)} centreT=${centreT.toFixed(2)} ` +
    `-> dive=${det == null ? "null" : det.toFixed(3)} (GT ${gtDive}) err=${err == null ? "n/a" : err} ` +
    `${res ? "conf=" + res.confidence.toFixed(2) + " apexT=" + res._debug.apexT.toFixed(2) + " entryT=" + (res._debug.entryT ?? "-") : ""}`);
}

function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const s of arr.sort((a, b) => a.t - b.t)) {
    const k = s.t.toFixed(3);
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}
