/* ---------------------------------------------------------------------------
   Detection pipeline. Pure JS — no React, no DOM, no Node-only APIs — so it can
   be scored against fixtures in `tools/score.mjs` as well as run in the browser.
   Every rule here was validated against real clips; the comments say which
   failure each one fixes.
   --------------------------------------------------------------------------- */

export const CAM_FRAC = 0.25;   // share of pixels changing that means the phone moved
export const CAM_MARGIN = 0.45; // seconds of margin around handled frames

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const pct = (a, p) => {
  const s = Float32Array.from(a).sort();
  return s[clamp(Math.floor((p / 100) * s.length), 0, s.length - 1)];
};

export function detect(samples, fps) {
  // samples: [{t, frac, cells}]  cells = per-cell abs luma difference (Uint8Array or
  // Float32Array — read numerically, so either works).
  const n = samples.length;
  if (n < 20) return { error: "Too few frames to read. Try again." };

  /* 1. Camera-handling gate.
     A person walking through frame changes a minority of pixels; the phone
     being set down or picked up changes most of them. An earlier version
     watched only the top of the frame for this, and threw away a whole dive
     because the swimmer's back filled the sky. Counting the share of changed
     pixels across the whole frame separates the two cleanly. */
  const steady = samples.map((s) => s.frac <= CAM_FRAC);
  const k = Math.max(1, Math.round(CAM_MARGIN * fps));
  const gated = steady.slice();
  for (let i = 0; i < n; i++)
    if (!steady[i])
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) gated[j] = false;
  const stableIdx = [];
  for (let i = 0; i < n; i++) if (gated[i]) stableIdx.push(i);
  if (stableIdx.length < fps * 2)
    return { error: "The camera moves for nearly the whole clip. Prop the phone up and reshoot." };

  /* 2. Water region: cells whose brightness varies over the steady frames.
     Deck and sky barely vary; the pool does. Measuring motion only inside it
     keeps deck movement from competing with the swim. */
  const cellCount = samples[0].cells.length;
  const mean = new Float32Array(cellCount);
  const varr = new Float32Array(cellCount);
  for (const i of stableIdx) for (let c = 0; c < cellCount; c++) mean[c] += samples[i].cells[c];
  for (let c = 0; c < cellCount; c++) mean[c] /= stableIdx.length;
  for (const i of stableIdx)
    for (let c = 0; c < cellCount; c++) {
      const d = samples[i].cells[c] - mean[c];
      varr[c] += d * d;
    }
  const vcut = pct(varr, 60);
  const roi = [];
  for (let c = 0; c < cellCount; c++) if (varr[c] > vcut) roi.push(c);
  if (roi.length < 20) return { error: "Couldn't find the water. Get more of the pool in frame." };

  /* 3. Water motion per frame. */
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of roi) s += samples[i].cells[c];
    e[i] = s / roi.length;
  }
  const eStable = stableIdx.map((i) => e[i]);
  /* Baseline from a low percentile, not the median. The median is dominated by
     the swim itself in a clip that is mostly swimming, which pushed the
     threshold above the swim and split it into fragments. */
  const base = pct(eStable, 10);
  const hi = pct(eStable, 97);
  const thr = base + 0.3 * (hi - base);

  /* 4. The swim is the longest sustained run of disturbed water. A swimmer
     walking into frame makes a louder spike than the dive, but it does not
     sustain, so it loses to the swim on length. */
  const gap = Math.round(0.6 * fps);
  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const active = e[i] > thr && gated[i];
    if (active) cur = cur ? [cur[0], i] : [i, i];
    else if (cur && i - cur[1] > gap) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  const long = runs.filter((r) => (r[1] - r[0]) / fps > 1.5);
  const [s0, s1] = long.length
    ? long.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a))
    : [stableIdx[0], stableIdx[stableIdx.length - 1]];

  /* 5. Candidate events, ranked by loudness and spread out in time.

     Taken from the whole camera-steady stretch, NOT just the "longest run" from
     step 4 — that run mislocalizes the swim on clips with a lot of on-deck prep
     (it can start after the touch). The loudest moments across the steady window
     are where the events are; which candidate is which is decided in step 6. */
  const lo = stableIdx[0];
  const hiIdx = stableIdx[stableIdx.length - 1];
  const order = Array.from({ length: hiIdx - lo + 1 }, (_, i) => lo + i)
    .filter((i) => gated[i])
    .sort((a, b) => e[b] - e[a]);
  const spread = Math.round(1.0 * fps);
  const peaks = [];
  for (const i of order) {
    if (peaks.every((p) => Math.abs(p - i) > spread)) peaks.push(i);
    if (peaks.length === 6) break;
  }
  /* For each peak, walk back to where its rise began. On a splash the leading
     edge sits closer to the event than the peak does, since the peak is water
     still flying after the swimmer has already arrived. */
  const raw = peaks
    .map((i) => {
      const foot = base + 0.6 * (e[i] - base);
      let j = i;
      while (j > lo && e[j - 1] > foot) j--;
      return { t: samples[j].t, peak: samples[i].t, v: e[i] };
    })
    .sort((a, b) => a.t - b.t);
  /* Two peaks can walk their leading edges back onto the same frame when the
     sampling is sparse. Collapse any within a third of a second, keeping the
     louder one. */
  const cands = [];
  for (const c of raw) {
    const prev = cands[cands.length - 1];
    if (prev && c.t - prev.t <= 0.34) {
      if (c.v > prev.v) cands[cands.length - 1] = c;
    } else cands.push(c);
  }

  /* 6. Best-effort dive / touch straight off the candidates, so the app shows a
     time the moment the scan finishes without the user placing anything.

     The read: the entry splash is the loudest disturbance in the first part of
     the swim, the finish the loudest in the rest. This holds when the phone is
     near the start (the common case) and breaks when it is far back — then
     on-deck prep or the swimmer climbing out is louder — so the app always
     labels these as a scan guess and offers the pose pass to pin the dive.

     The first ~0.6s is skipped: a camera still settling makes a big spike there. */
  const t0 = samples[lo].t;
  const tEnd = samples[hiIdx].t;
  const usable = cands.filter((c) => c.t > t0 + 0.6);
  const mid = t0 + 0.55 * (tEnd - t0);
  const loudest = (list) => list.reduce((a, b) => (a && a.v >= b.v ? a : b), null);

  const earlyCands = usable.filter((c) => c.t <= mid);
  const loudEarly = loudest(earlyCands);
  /* Dive: the *earliest* early candidate that's within ~45% of the loudest —
     a splash builds to its peak, so its leading edge is the earlier of the two
     candidates it usually throws, and that edge is nearer the feet leaving. */
  const diveC =
    (loudEarly && earlyCands.find((c) => c.v >= 0.45 * loudEarly.v)) || loudEarly || usable[0] || null;
  let dive = diveC ? diveC.t : null;
  const touchC = loudest(usable.filter((c) => c.t > (dive ?? mid) + 1));
  let touch = touchC ? touchC.t : null;

  return {
    steadyFrom: samples[stableIdx[0]].t,
    steadyTo: samples[stableIdx[stableIdx.length - 1]].t,
    swim: [samples[s0].t, samples[s1].t],
    dive,
    touch,
    candidates: cands,
    trace: samples.map((s, i) => ({ t: s.t, v: e[i], ok: gated[i] })),
    roiFrac: roi.length / cellCount,
  };
}
