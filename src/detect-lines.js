/* ---------------------------------------------------------------------------
   detect-lines.js — automatic pool-edge + line-crossing swim-event detector.

   THE "FUTURE RESHOOT" PATH.  src/detect.js narrows a clip to ranked loudness
   candidates and refuses to name the dive or the touch, because from the four
   corner-shot reference clips the geometry does not support it (near wall is an
   oblique curve, far wall is a treeline speck, the strongest straight edge in
   the median frame is a hedge).  A pose pass reached the same conclusion.

   The classical-CV fix is a camera position, not an algorithm: put the phone on
   the LONG side of the pool with BOTH end walls in frame and the water surface
   roughly horizontal.  Then every event is the same primitive — "a point
   crosses a fixed image line":

       dive   = swimmer crosses the NEAR end-wall line   (first time)
       turn   = swimmer crosses the FAR  end-wall line   (mid clip)
       touch  = swimmer crosses the NEAR end-wall line   (last time)

   This module builds that detector so a reshoot is plug-and-play.  Run against
   the current four clips it is EXPECTED to return `unfound` with a note naming
   the camera problem — see tools/lines/score-lines.mjs.  It is proven to work
   when the geometry cooperates — see tools/lines/SYNTHETIC.md.

   It reports events ONLY when it can see the whole two-length structure:
     - two parallel, well-separated wall lines that each border moving water on
       one side and static deck on the other;
     - a motion burst at the near wall (dive), then a quiet spell there while a
       burst crosses the far wall (turn), then another near-wall burst (touch).
   Anything less -> everything null, all three in `unfound`, `diagnostics.reason`
   names why.  It is all-or-nothing: there is no partial answer, no fallback to
   a hardcoded row, no draggable-line UI.  A two-length swim, dive to touch, is
   the only thing it is built to read; a dive-only or single-length clip will
   land in `unfound`.

   --------------------------------------------------------------------------- *
   INTERFACE
   --------------------------------------------------------------------------- *

   detectLines(frames, opts) -> result   (see RESULT below)

   `frames` — a decoded GRAYSCALE frame stack.  Two shapes are accepted:

     1. An ARRAY of frames.  Each element is either
          - a typed array / number array of length width*height (row-major,
            luma 0..255), with `opts.width` and `opts.height` giving the
            dimensions, or
          - an object { data, width, height, t? } where `data` is that array.

     2. An ACCESSOR object:
          {
            count : number,                 // frame count
            width : number,                 // pixels, every frame the same
            height: number,
            fps   : number,                 // frames per second
            at(i) : (Uint8Array|number[])   // O(1); grayscale luma, len w*h
            t?(i) : number                  // seconds; default i / fps
          }
        `at(i)` MUST be cheap and return a stable-length grayscale buffer.
        Hold the frames yourself (a ~200px-wide stack of a 40 s clip is
        ~90 MB); this module never decodes video.

   Coordinate system: working pixels of the supplied frames, origin top-left,
   +y down.  `result.frameSize` echoes the dimensions so a caller that decoded
   at reduced resolution can scale the returned line endpoints back to full res.

   HOW App.jsx SHOULD CALL IT
   --------------------------------------------------------------------------- *
   Do a second muted pass like `runScan`, but draw each presented frame into a
   ~200px-wide canvas and keep the luma buffer:

       const W = 200, H = Math.round(W * v.videoHeight / v.videoWidth);
       const stack = [];                       // Uint8Array[]  (one per frame)
       // ... in requestVideoFrameCallback: drawImage(v,0,0,W,H); read luma; stack.push(buf)
       const r = detectLines(
         { count: stack.length, width: W, height: H, fps: effFps, at: i => stack[i] },
         {}
       );
       if (r.dive  != null) setDive(r.dive);
       if (r.turn  != null) setTurn(r.turn);
       if (r.touch != null) setTouch(r.touch);
       // r.unfound + r.notes explain anything missing; r.lines can be drawn as
       // an overlay (scale by videoWidth / r.frameSize.width).

   RESULT
   --------------------------------------------------------------------------- *
   {
     dive:  number|null,        // seconds — energy-weighted centre of the crossing burst
     turn:  number|null,
     touch: number|null,
     uncertainty: { dive, turn, touch },   // ± seconds, ~half the burst width
                                           //   (null where the event is null)
     lines: [                    // exactly 0 or 2 wall lines, near first
       {
         role: 'near'|'far',
         theta, rho,             // normal form: x*cosθ + y*sinθ = rho
         angleDeg,               // 0 = horizontal line, 90 = vertical line
         orientation: 'horizontal'|'vertical'|'oblique',
         x1,y1,x2,y2,            // in-image segment endpoints, working pixels
         meanY,
         votes, votesNorm,       // Hough support
         sideVariance: [a,b],    // mean temporal variance either side of line
         waterContrast,          // max(side)/min(side); >1 means a real boundary
         waterSide: 'A'|'B',     // which normal side is the water
         bandBaseline, bandPeak, // motion energy in the sampling band
       }
     ],
     frameSize: { width, height },   // working-pixel dims; scale line endpoints by
                                     //   videoWidth / frameSize.width for a full-res overlay
     notes: string[],            // human-readable trace of what happened
     unfound: string[],          // [] on success, else ['dive','turn','touch']
     diagnostics: {
       fps, frameCount, steadySpan:[t,t], steadyFrames,
       cameraMovedFrac,          // share of clip lost to the camera-handling gate
       houghMax,
       candidates: [ { theta, rho, angleDeg, votes, verdict } ],  // every line tried
       reason?: string,          // set whenever unfound is non-empty
     }
   }

   Pure browser-compatible JS: no React, no DOM, no Node built-ins.
   --------------------------------------------------------------------------- */

export const DEFAULTS = {
  // camera-handling gate (mirrors src/detect.js CAM_FRAC / CAM_MARGIN)
  camFrac: 0.25,          // share of pixels changing that means the phone moved
  camMarginSec: 0.45,     // seconds blanked either side of a handled frame
  camDiffThresh: 12,      // abs luma diff that counts a pixel as "changed"

  // temporal background / variance map
  medianSamples: 80,      // frames sampled across the steady window for median+variance

  // edge + line detection on the median frame
  gradPct: 90,            // percentile of gradient magnitude kept as edge points
  thetaStepDeg: 1,        // Hough angular resolution
  rhoStep: 2,             // Hough distance resolution, pixels
  allowedOrientations: ['horizontal', 'vertical'],
  orientTolDeg: 22,       // how far from horizontal/vertical a kept line may sit
  nmsThetaDeg: 8,         // non-max suppression window
  nmsRho: 24,
  peakFrac: 0.35,         // Hough peak must be >= this * global max
  maxCandidates: 14,      // Hough peaks scored for the water-boundary test
  maxLines: 2,            // accepted lines

  // water-boundary test
  bandGapPx: 3,           // start of the side window, offset from the line
  bandSpanPx: 7,          // depth of the side window along the normal
  sampleCount: 140,       // points sampled along the line
  minWaterContrast: 1.7,  // required varHi / varLo across the line
  waterVarPct: 45,        // one side must exceed this percentile of the variance map

  // motion-energy band + event rises
  bandPx: 4,              // half-depth of the motion-energy band along the normal
  bandSegments: 16,       // tiles along the line; per frame = loudest tile's motion
  smoothMaxRadius: 2,     // temporal max-filter radius on the band series
  smoothMeanRadius: 1,    // then mean-filter radius
  riseBaselinePct: 50,   // "quiet water" level (continuous sparkle sits here)
  risePeakPct: 98,       // event level — robust max, not the median of a mostly-quiet band
  riseFrac: 0.32,        // threshold = baseline + riseFrac*(peak-baseline)
  minRiseSec: 0.13,       // a rise must stay above threshold this long
  mergeGapSec: 0.5,       // rises closer than this are one rise
  minEventGapSec: 4.0,    // dive and touch must be at least this far apart

  // crossing-line gate: a line the swimmer CROSSES is quiet most of the clip
  // and spikes briefly (dive / turn / touch). A line the swimmer swims ALONG
  // (a lane rope, the long-side deck/water edge of a corner shot) is hot for
  // most of the swim. Reject any line whose band is hot too often.
  maxDutyCycle: 0.40,     // max share of steady frames the band may exceed threshold
  maxFill: 0.33,          // max share of the first-rise..last-rise span the band may be hot
  dutyFrac: 0.35,         // "hot" = baseline + dutyFrac*(peak-baseline)

  // two-wall geometry gate.  Timing a two-length swim means SEEING the swimmer
  // leave the near wall, reach the far wall and come back.  That needs two
  // opposed, parallel, well-separated wall lines with the swimmer's motion
  // alternating between them.  A single edge — or two copies of the same edge —
  // cannot tell a finishing touch from mid-pool thrashing next to that edge.
  requireTwoWalls: true,
  maxWallAngleDiffDeg: 12, // the two walls must be this close to parallel
  minWallSepFrac: 0.22,    // and this far apart, as a fraction of the frame
  // and the swimmer must be seen to ALTERNATE between them: a burst at the near
  // wall (dive), a quiet spell there while a burst crosses the far wall (turn),
  // then another near-wall burst (touch). Two edges that run ALONG the swim
  // (near + far long side of the pool) do not produce this.
  maxMiddleHotFrac: 0.22,  // near band may be active at most this much between dive and touch
  quietGuardSec: 0.6,      // window checked for "the other band is quiet here"

  // edge-activity gate: on a corner shot the loudest thing in any water-edge
  // band is a person entering or (usually) climbing out of the pool right in
  // front of the camera, at the very start or end of the steady window — not a
  // swim crossing. A real end wall is struck at dive AND touch with comparable
  // energy, inside the swim, away from the clip edges.
  edgeMarginSec: 1.6,     // window at each end of the steady span treated as "clip edge"
  edgeDominanceRatio: 1.15, // reject if edge-window peak exceeds this * interior peak
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const D2R = Math.PI / 180;

function percentile(arr, p) {
  const s = Float64Array.from(arr).sort();
  return s[clamp(Math.floor((p / 100) * s.length), 0, s.length - 1)];
}

/* --- frame-stack normalisation ------------------------------------------- */

function normalizeFrames(frames, opts) {
  if (Array.isArray(frames)) {
    if (!frames.length) throw new Error('detectLines: empty frame array');
    const first = frames[0];
    const isObj = first && first.data != null;
    const width = isObj ? first.width : opts.width;
    const height = isObj ? first.height : opts.height;
    if (!width || !height)
      throw new Error('detectLines: pass opts.width/opts.height with a bare frame array');
    const fps = opts.fps || frames.length / (opts.duration || frames.length / 30);
    return {
      count: frames.length,
      width,
      height,
      fps,
      at: (i) => (isObj ? frames[i].data : frames[i]),
      t: (i) => (isObj && frames[i].t != null ? frames[i].t : i / fps),
    };
  }
  const f = frames;
  if (!f || typeof f.at !== 'function' || !f.count)
    throw new Error('detectLines: frames must be an array or an accessor { count,width,height,fps,at }');
  const fps = f.fps || opts.fps || 30;
  return {
    count: f.count,
    width: f.width,
    height: f.height,
    fps,
    at: (i) => f.at(i),
    t: (i) => (typeof f.t === 'function' ? f.t(i) : i / fps),
  };
}

/* --- 1. camera-handling gate ------------------------------------------------
   A frame whose luma differs from the previous one across more than camFrac of
   its pixels is the phone being moved; blank camMarginSec either side.  Same
   idea as src/detect.js, done here straight off the grayscale stack. */

function cameraGate(F, opts) {
  const { count, width: w, height: h } = F;
  const N = w * h;
  const moved = new Uint8Array(count); // 1 = phone moved at this frame
  let prev = F.at(0);
  for (let i = 1; i < count; i++) {
    const cur = F.at(i);
    let changed = 0;
    for (let j = 0; j < N; j++) {
      const d = cur[j] - prev[j];
      if ((d < 0 ? -d : d) > opts.camDiffThresh) changed++;
    }
    if (changed / N > opts.camFrac) moved[i] = 1;
    prev = cur;
  }
  const k = Math.max(1, Math.round(opts.camMarginSec * F.fps));
  const steady = new Uint8Array(count).fill(1);
  for (let i = 0; i < count; i++)
    if (moved[i])
      for (let j = Math.max(0, i - k); j <= Math.min(count - 1, i + k); j++) steady[j] = 0;
  const steadyIdx = [];
  for (let i = 0; i < count; i++) if (steady[i]) steadyIdx.push(i);
  return { steady, steadyIdx, movedFrac: 1 - steadyIdx.length / count };
}

/* --- 2. temporal median background + variance map ----------------------- */

function temporalStats(F, steadyIdx, opts) {
  const { width: w, height: h } = F;
  const N = w * h;
  const S = Math.min(opts.medianSamples, steadyIdx.length);
  const pick = [];
  for (let s = 0; s < S; s++) pick.push(steadyIdx[Math.floor((s + 0.5) * steadyIdx.length / S)]);
  const buffers = pick.map((i) => F.at(i));

  const median = new Float32Array(N);
  const variance = new Float32Array(N);
  const col = new Float64Array(S);
  for (let p = 0; p < N; p++) {
    let sum = 0;
    for (let s = 0; s < S; s++) {
      const v = buffers[s][p];
      col[s] = v;
      sum += v;
    }
    // insertion sort — S is small (<=80)
    for (let a = 1; a < S; a++) {
      const x = col[a];
      let b = a - 1;
      while (b >= 0 && col[b] > x) { col[b + 1] = col[b]; b--; }
      col[b + 1] = x;
    }
    median[p] = S & 1 ? col[(S - 1) >> 1] : 0.5 * (col[S >> 1] + col[(S >> 1) - 1]);
    const mean = sum / S;
    let acc = 0;
    for (let s = 0; s < S; s++) { const d = buffers[s][p] - mean; acc += d * d; }
    variance[p] = acc / S;
  }
  return { median, variance, sampled: S };
}

/* --- 3. Sobel gradient magnitude on the median frame -------------------- */

function sobelMag(img, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = img[i - w - 1], b = img[i - w], c = img[i - w + 1];
      const d = img[i - 1], f = img[i + 1];
      const g = img[i + w - 1], hh = img[i + w], k = img[i + w + 1];
      const gx = c + 2 * f + k - a - 2 * d - g;
      const gy = g + 2 * hh + k - a - 2 * b - c;
      mag[i] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

/* --- 4. Hough line accumulation ---------------------------------------- */

function houghPeaks(mag, w, h, opts) {
  const magCut = percentile(mag, opts.gradPct);
  const edges = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      if (mag[y * w + x] >= magCut) edges.push(x, y, mag[y * w + x]);

  const thetaStep = opts.thetaStepDeg * D2R;
  const nTheta = Math.round(Math.PI / thetaStep);
  const cos = new Float32Array(nTheta);
  const sin = new Float32Array(nTheta);
  for (let ti = 0; ti < nTheta; ti++) {
    cos[ti] = Math.cos(ti * thetaStep);
    sin[ti] = Math.sin(ti * thetaStep);
  }
  const diag = Math.hypot(w, h);
  const rhoOff = Math.ceil(diag / opts.rhoStep);
  const nRho = 2 * rhoOff + 1;
  const acc = new Float32Array(nTheta * nRho);
  for (let e = 0; e < edges.length; e += 3) {
    const x = edges[e], y = edges[e + 1], wgt = edges[e + 2];
    for (let ti = 0; ti < nTheta; ti++) {
      const rho = x * cos[ti] + y * sin[ti];
      const ri = Math.round(rho / opts.rhoStep) + rhoOff;
      if (ri >= 0 && ri < nRho) acc[ti * nRho + ri] += wgt;
    }
  }

  let gmax = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > gmax) gmax = acc[i];
  const floor = opts.peakFrac * gmax;

  const raw = [];
  for (let ti = 0; ti < nTheta; ti++)
    for (let ri = 0; ri < nRho; ri++) {
      const v = acc[ti * nRho + ri];
      if (v < floor) continue;
      raw.push({ ti, ri, v, theta: ti * thetaStep, rho: (ri - rhoOff) * opts.rhoStep });
    }
  raw.sort((a, b) => b.v - a.v);

  // non-max suppression in (theta, rho)
  const nmsT = opts.nmsThetaDeg * D2R;
  const kept = [];
  for (const p of raw) {
    let near = false;
    for (const q of kept) {
      let dt = Math.abs(p.theta - q.theta);
      dt = Math.min(dt, Math.PI - dt);
      if (dt < nmsT && Math.abs(p.rho - q.rho) < opts.nmsRho) { near = true; break; }
    }
    if (!near) kept.push(p);
    if (kept.length >= opts.maxCandidates) break;
  }
  return { peaks: kept, gmax };
}

/* line geometry: normal form x*cosθ + y*sinθ = rho.
   direction along the line = (-sinθ, cosθ). Returns the in-image segment as a
   parameter range [tmin,tmax] about the foot point (rho*cosθ, rho*sinθ). */
function lineSegment(theta, rho, w, h) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const px = c * rho, py = s * rho;
  const dx = -s, dy = c;
  let tmin = -1e9, tmax = 1e9;
  const lo = 1, hiX = w - 2, hiY = h - 2;
  if (Math.abs(dx) > 1e-9) {
    let ta = (lo - px) / dx, tb = (hiX - px) / dx;
    if (ta > tb) [ta, tb] = [tb, ta];
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
  } else if (px < lo || px > hiX) return null;
  if (Math.abs(dy) > 1e-9) {
    let ta = (lo - py) / dy, tb = (hiY - py) / dy;
    if (ta > tb) [ta, tb] = [tb, ta];
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
  } else if (py < lo || py > hiY) return null;
  if (tmax - tmin < 8) return null;
  return { c, s, px, py, dx, dy, tmin, tmax };
}

function lineAngleDeg(theta) {
  // line direction relative to horizontal; 0 = horizontal, 90 = vertical
  let a = (theta / D2R - 90);
  a = ((a % 180) + 180) % 180;
  return a > 90 ? 180 - a : a;
}

function classifyOrientation(angleDeg, tol) {
  if (angleDeg <= tol) return 'horizontal';
  if (angleDeg >= 90 - tol) return 'vertical';
  return 'oblique';
}

/* --- 5. water-boundary test for one candidate line -------------------- */

function evaluateLine(peak, seg, variance, w, h, varCut, opts) {
  const { c, s, px, py, dx, dy, tmin, tmax } = seg;
  const n = opts.sampleCount;
  let sideA = 0, sideB = 0, cntA = 0, cntB = 0, ySum = 0, yCnt = 0;
  const sampleSide = (x0, y0, sign) => {
    let acc = 0, cnt = 0;
    for (let d = opts.bandGapPx; d < opts.bandGapPx + opts.bandSpanPx; d++) {
      const x = Math.round(x0 + sign * c * d);
      const y = Math.round(y0 + sign * s * d);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      acc += variance[y * w + x];
      cnt++;
    }
    return cnt ? [acc, cnt] : null;
  };
  for (let i = 0; i < n; i++) {
    const tt = tmin + (i + 0.5) * (tmax - tmin) / n;
    const x0 = px + dx * tt, y0 = py + dy * tt;
    ySum += y0; yCnt++;
    const A = sampleSide(x0, y0, +1);
    const B = sampleSide(x0, y0, -1);
    if (A) { sideA += A[0]; cntA += A[1]; }
    if (B) { sideB += B[0]; cntB += B[1]; }
  }
  if (!cntA || !cntB) return null;
  const va = sideA / cntA, vb = sideB / cntB;
  const hi = Math.max(va, vb), loV = Math.min(va, vb);
  const contrast = hi / Math.max(loV, 1e-6);
  const touchesWater = hi >= varCut;
  const angleDeg = lineAngleDeg(peak.theta);
  const orientation = classifyOrientation(angleDeg, opts.orientTolDeg);
  return {
    theta: peak.theta,
    rho: peak.rho,
    votes: peak.v,
    angleDeg,
    orientation,
    meanY: ySum / yCnt,
    sideVariance: [va, vb],
    waterContrast: contrast,
    waterSide: va >= vb ? 'A' : 'B',
    touchesWater,
    seg,
  };
}

/* --- 6. per-frame motion energy inside a line's band ------------------- */

function bandSeries(F, seg, opts) {
  const { count, width: w, height: h } = F;
  const { c, s, px, py, dx, dy, tmin, tmax } = seg;
  const nS = opts.sampleCount;
  const nSeg = Math.max(4, opts.bandSegments);
  // group the sampled band pixels into nSeg tiles along the line. A swimmer
  // crossing is LOCAL in x, so it lights one tile hard while the rest stay
  // quiet; a uniform surface flicker lifts every tile the same small amount.
  // Per frame: energy = mean abs-diff of the loudest tile. That separates a
  // point-crossing from an even shimmer far better than averaging the whole line.
  const tiles = Array.from({ length: nSeg }, () => []);
  for (let i = 0; i < nS; i++) {
    const frac = (i + 0.5) / nS;
    const tt = tmin + frac * (tmax - tmin);
    const x0 = px + dx * tt, y0 = py + dy * tt;
    const bin = Math.min(nSeg - 1, Math.floor(frac * nSeg));
    for (let d = -opts.bandPx; d <= opts.bandPx; d++) {
      const x = Math.round(x0 + c * d);
      const y = Math.round(y0 + s * d);
      if (x >= 0 && y >= 0 && x < w && y < h) tiles[bin].push(y * w + x);
    }
  }
  const raw = new Float32Array(count);
  let prev = F.at(0);
  for (let i = 1; i < count; i++) {
    const cur = F.at(i);
    let best = 0;
    for (let t = 0; t < nSeg; t++) {
      const px2 = tiles[t];
      if (px2.length < 4) continue;
      let acc = 0;
      for (let p = 0; p < px2.length; p++) {
        const d = cur[px2[p]] - prev[px2[p]];
        acc += d < 0 ? -d : d;
      }
      const m = acc / px2.length;
      if (m > best) best = m;
    }
    raw[i] = best;
    prev = cur;
  }
  raw[0] = raw[1] || 0;
  // motion energy from frame differencing is bursty — a slowly moving edge
  // lands on alternating frames, and codecs hold some frames identical. A tiny
  // max-then-mean smooth fills those one-frame holes without smearing the
  // leading edge (which we walk back to its foot anyway).
  const r1 = opts.smoothMaxRadius, r2 = opts.smoothMeanRadius;
  const mx = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let m = 0;
    for (let k = -r1; k <= r1; k++) { const j = i + k; if (j >= 0 && j < count && raw[j] > m) m = raw[j]; }
    mx[i] = m;
  }
  const series = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let s = 0, n = 0;
    for (let k = -r2; k <= r2; k++) { const j = i + k; if (j >= 0 && j < count) { s += mx[j]; n++; } }
    series[i] = s / n;
  }
  return series;
}

/* --- 7. leading-edge rises in a band series --------------------------- */

function findRises(series, steady, F, opts) {
  const stableVals = [];
  for (let i = 0; i < series.length; i++) if (steady[i]) stableVals.push(series[i]);
  if (stableVals.length < 5) return { rises: [], baseline: 0, peak: 0, thr: 0 };
  const baseline = percentile(stableVals, opts.riseBaselinePct);
  const peak = percentile(stableVals, opts.risePeakPct);
  const thr = baseline + opts.riseFrac * (peak - baseline);
  const minLen = Math.max(1, Math.round(opts.minRiseSec * F.fps));
  const mergeGap = Math.round(opts.mergeGapSec * F.fps);

  const runs = [];
  let start = -1;
  for (let i = 0; i < series.length; i++) {
    const active = steady[i] && series[i] > thr;
    if (active && start < 0) start = i;
    else if (!active && start >= 0) {
      if (i - start >= minLen) runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0 && series.length - start >= minLen) runs.push([start, series.length - 1]);

  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= mergeGap) last[1] = r[1];
    else merged.push(r.slice());
  }

  const rises = merged.map(([a, b]) => {
    // expand to the foot of the rise on both sides
    const foot = baseline + 0.4 * (Math.max(series[a], series[b]) - baseline);
    let j = a;
    while (j > 0 && steady[j - 1] && series[j - 1] > foot) j--;
    let e = b;
    while (e < series.length - 1 && steady[e + 1] && series[e + 1] > foot) e++;
    let pk = j, pkv = series[j];
    for (let i = j; i <= e; i++) if (series[i] > pkv) { pkv = series[i]; pk = i; }
    // A point crossing a line makes a burst of band motion that is roughly
    // SYMMETRIC about the instant of the crossing (energy as the swimmer
    // enters the band, a lull while they fill it, energy as they leave). The
    // energy-weighted centroid sits on that instant and is robust to the
    // double hump; the leading edge is ~half a band-transit early.
    let num = 0, den = 0;
    for (let i = j; i <= e; i++) { const wv = Math.max(0, series[i] - foot); num += wv * i; den += wv; }
    const cIdx = den > 0 ? num / den : pk;
    return {
      leadIdx: j,
      tLead: F.t(j),
      tPeak: F.t(pk),
      tCross: (den > 0 ? cIdx : pk) / F.fps,
      peakVal: pkv,
      width: (e - j) / F.fps,
      halfWidth: Math.max(1 / F.fps, 0.5 * (e - j) / F.fps),
    };
  });
  return { rises, baseline, peak, thr };
}

/* --- assemble ---------------------------------------------------------- */

export function detectLines(frames, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const F = normalizeFrames(frames, o);

  const notes = [];
  const unfound = [];
  const frameSize = { width: F.width, height: F.height };
  const nullResult = (reason) => ({
    dive: null, turn: null, touch: null,
    uncertainty: { dive: null, turn: null, touch: null },
    lines: [],
    frameSize,
    notes,
    unfound: ['dive', 'turn', 'touch'],
    diagnostics: { fps: F.fps, frameCount: F.count, reason },
  });

  if (F.count < 30) return nullResult('clip too short to read (need ~1 s)');

  /* 1. camera gate */
  const { steady, steadyIdx, movedFrac } = cameraGate(F, o);
  if (steadyIdx.length < F.fps * 2) {
    notes.push('camera moves for almost the whole clip — prop the phone up');
    return nullResult('camera never holds still long enough to fit a background');
  }
  const steadySpan = [F.t(steadyIdx[0]), F.t(steadyIdx[steadyIdx.length - 1])];

  /* 2. temporal background + variance */
  const { median, variance, sampled } = temporalStats(F, steadyIdx, o);
  const varCut = percentile(variance, o.waterVarPct);
  notes.push(`background from ${sampled} steady frames; water-variance cut at p${o.waterVarPct} = ${varCut.toFixed(1)}`);

  /* 3-4. edges + Hough */
  const mag = sobelMag(median, F.width, F.height);
  const { peaks, gmax } = houghPeaks(mag, F.width, F.height, o);

  /* 5. score every candidate against the water-boundary test */
  const diagCandidates = [];
  const scored = [];
  for (const pk of peaks) {
    const angleDeg = lineAngleDeg(pk.theta);
    const orientation = classifyOrientation(angleDeg, o.orientTolDeg);
    const seg = lineSegment(pk.theta, pk.rho, F.width, F.height);
    if (!seg) {
      diagCandidates.push({ theta: pk.theta, rho: pk.rho, angleDeg, votes: pk.v, verdict: 'off-frame' });
      continue;
    }
    if (o.allowedOrientations.length && !o.allowedOrientations.includes(orientation)) {
      diagCandidates.push({ theta: pk.theta, rho: pk.rho, angleDeg, votes: pk.v, verdict: `orientation ${orientation} (want ${o.allowedOrientations.join('/')})` });
      continue;
    }
    const ev = evaluateLine(pk, seg, variance, F.width, F.height, varCut, o);
    if (!ev) {
      diagCandidates.push({ theta: pk.theta, rho: pk.rho, angleDeg, votes: pk.v, verdict: 'could not sample both sides' });
      continue;
    }
    let verdict;
    if (!ev.touchesWater) verdict = `both sides static (var ${ev.sideVariance.map((x) => x.toFixed(1)).join(' / ')}) — not a water edge`;
    else if (ev.waterContrast < o.minWaterContrast) verdict = `no water/deck contrast (ratio ${ev.waterContrast.toFixed(2)} < ${o.minWaterContrast})`;
    else verdict = 'accepted';
    diagCandidates.push({ theta: pk.theta, rho: pk.rho, angleDeg, votes: pk.v, verdict });
    if (verdict === 'accepted') scored.push(ev);
  }

  if (!scored.length) {
    notes.push(
      'no straight edge in the median frame borders the moving water on one side and static deck on the other.'
    );
    notes.push(
      'this is the corner-camera failure: the near wall is an oblique curve (no single straight chord follows it), ' +
      'the far wall is lost in the treeline, and the strongest straight edge is a hedge with static ground on both sides.'
    );
    const r = nullResult(
      'auto edge detection found no usable wall line. Camera problem: shot from a pool corner — ' +
      'near wall oblique/curved, far wall hidden in foliage, strongest edge is the hedge. ' +
      'Reshoot from the LONG side with both end walls in frame and the water line horizontal.'
    );
    r.diagnostics.steadySpan = steadySpan;
    r.diagnostics.steadyFrames = steadyIdx.length;
    r.diagnostics.cameraMovedFrac = movedFrac;
    r.diagnostics.candidates = diagCandidates;
    r.diagnostics.houghMax = gmax;
    return r;
  }

  /* keep the best-supported lines, then gate each on its motion band:
     it must read as a line the swimmer CROSSES, not one they swim ALONG. */
  scored.sort((a, b) => b.votes * b.waterContrast - a.votes * a.waterContrast);
  const nSteady = steadyIdx.length;
  const debugBands = [];
  const kept = [];
  for (const ln of scored) {
    ln.series = bandSeries(F, ln.seg, o);
    const rr = findRises(ln.series, steady, F, o);
    const hot = rr.baseline + o.dutyFrac * (rr.peak - rr.baseline);
    let hotFrames = 0;
    for (let i = 0; i < ln.series.length; i++)
      if (steady[i] && ln.series[i] > hot) hotFrames++;
    const duty = hotFrames / Math.max(nSteady, 1);
    // fill factor: within the span from the first rise to the last, how much of
    // the time is the band hot? Two brief crossings at the ends of a long span
    // give a low fill; a swimmer travelling along the line keeps it hot -> high.
    let fill = 0, spanLen = 0;
    if (rr.rises.length >= 2) {
      const a = rr.rises[0].leadIdx;
      const b = rr.rises[rr.rises.length - 1].leadIdx;
      let hf = 0, tot = 0;
      for (let i = a; i <= b; i++) if (steady[i]) { tot++; if (ln.series[i] > hot) hf++; }
      spanLen = (b - a) / F.fps;
      fill = tot ? hf / tot : 1;
    } else {
      fill = 0; // a single rise can't be an along-line
    }
    ln.fill = fill;
    ln.duty = duty;
    debugBands.push({
      angleDeg: ln.angleDeg, rho: ln.rho, meanY: ln.meanY,
      duty, fill, spanLen, baseline: rr.baseline, peak: rr.peak, thr: rr.thr, riseCount: rr.rises.length,
    });
    const rej = (why) => {
      const di = diagCandidates.find((c) => c.rho === ln.rho && Math.abs(c.theta - ln.theta) < 1e-6);
      if (di) di.verdict = why;
    };
    if (duty > o.maxDutyCycle) { rej(`swim runs ALONG this line (band hot ${(duty * 100).toFixed(0)}% of the whole clip)`); continue; }
    if (fill > o.maxFill) { rej(`swim runs ALONG this line (band hot ${(fill * 100).toFixed(0)}% of the interval between its first and last rise, not two brief crossings)`); continue; }

    // edge-activity gate
    const em = Math.max(1, Math.round(o.edgeMarginSec * F.fps));
    const s0 = steadyIdx[0], s1 = steadyIdx[steadyIdx.length - 1];
    let edgePeak = 0, interiorPeak = 0;
    for (let i = 0; i < ln.series.length; i++) {
      if (!steady[i] || i < s0 || i > s1) continue;
      if (i - s0 < em || s1 - i < em) edgePeak = Math.max(edgePeak, ln.series[i]);
      else interiorPeak = Math.max(interiorPeak, ln.series[i]);
    }
    ln.edgePeak = edgePeak;
    ln.interiorPeak = interiorPeak;
    debugBands[debugBands.length - 1].edgePeak = edgePeak;
    debugBands[debugBands.length - 1].interiorPeak = interiorPeak;
    if (edgePeak > o.edgeDominanceRatio * Math.max(interiorPeak, 1e-6)) {
      rej(`band is dominated by activity at the clip edge (peak ${edgePeak.toFixed(1)} in the first/last ${o.edgeMarginSec}s vs ${interiorPeak.toFixed(1)} across the swim) — that is someone entering/leaving the pool by the camera, not a crossing`);
      continue;
    }
    kept.push(ln);
    if (kept.length >= o.maxLines && !opts.__debugBands && !opts.__dumpSeries) break;
  }
  if (kept.length > o.maxLines) kept.length = o.maxLines;

  if (opts.__debugBands) {
    return { _debug: { bands: debugBands.map((b, i) => ({ ...b, role: kept[i] ? kept[i].role || `#${i}` : `rej#${i}` })) } };
  }
  if (opts.__dumpSeries) {
    return {
      _series: scored
        .filter((ln) => ln.series)
        .map((ln, i) => ({ role: kept.includes(ln) ? `keep#${i}` : `rej#${i}`, meanY: ln.meanY, series: ln.series })),
    };
  }

  const withDiag = (r) => {
    r.diagnostics.steadySpan = steadySpan;
    r.diagnostics.steadyFrames = steadyIdx.length;
    r.diagnostics.cameraMovedFrac = movedFrac;
    r.diagnostics.candidates = diagCandidates;
    r.diagnostics.houghMax = gmax;
    return r;
  };
  const CAMERA_NOTE =
    'Reshoot from the LONG side of the pool with BOTH end walls in frame and the water ' +
    'surface roughly horizontal; then dive, turn and touch are each just "a tracked point ' +
    'crosses a fixed image line".';

  /* --- two-wall geometry gate -------------------------------------------- */
  if (o.requireTwoWalls && kept.length < 2) {
    if (!kept.length) {
      notes.push(
        'no straight edge borders moving water on one side and static deck on the other, ' +
        'or every candidate that does reads as a line the swimmer travels ALONG (its motion ' +
        'band stays hot) rather than one they cross at a point.'
      );
    } else {
      notes.push(
        `only one usable water edge found (${kept[0].orientation}, y~${kept[0].meanY.toFixed(0)}, ` +
        `water/deck contrast ${kept[0].waterContrast.toFixed(1)}). One edge cannot time a ` +
        'two-length swim: there is no way to tell a finishing touch from mid-pool thrashing ' +
        'beside that same edge without also seeing the far wall.'
      );
    }
    notes.push(
      'corner-camera geometry: the near wall is an oblique curve (no straight chord follows ' +
      'it), the far wall is a treeline speck, and the only long straight water edge in frame ' +
      'runs the LENGTH of the swim, not across it.'
    );
    return withDiag(nullResult(
      `need two opposed pool-end walls in frame — found ${kept.length}. ${CAMERA_NOTE}`
    ));
  }

  /* the two lines must be parallel and well separated to be two ends of one pool */
  let near, far;
  {
    const [L1, L2] = kept;
    const dAng = Math.abs(L1.angleDeg - L2.angleDeg);
    if (dAng > o.maxWallAngleDiffDeg) {
      notes.push(
        `the two strongest water edges are ${dAng.toFixed(0)}° apart in orientation ` +
        `(${L1.orientation} vs ${L2.orientation}) — not two parallel walls of one pool.`
      );
      return withDiag(nullResult(`the two detected edges are not parallel. ${CAMERA_NOTE}`));
    }
    const mx = 0.5 * ((L1.seg.px + L1.seg.dx * L1.seg.tmin) + (L1.seg.px + L1.seg.dx * L1.seg.tmax));
    const my = 0.5 * ((L1.seg.py + L1.seg.dy * L1.seg.tmin) + (L1.seg.py + L1.seg.dy * L1.seg.tmax));
    const sep = Math.abs(mx * Math.cos(L2.theta) + my * Math.sin(L2.theta) - L2.rho);
    const denom = L1.orientation === 'vertical' ? F.width : F.height;
    const sepFrac = sep / denom;
    if (sepFrac < o.minWallSepFrac) {
      notes.push(
        `the two detected edges are only ${(sepFrac * 100).toFixed(0)}% of the frame apart — ` +
        'that is one pool edge picked up twice, not opposite end walls.'
      );
      return withDiag(nullResult(
        `only one distinct water edge (found twice, ${(sepFrac * 100).toFixed(0)}% of the frame apart). ${CAMERA_NOTE}`
      ));
    }
    /* NEAR = closer to the camera: lower in the frame for a horizontal water
       line; otherwise the line whose band carries more total motion (the
       swimmer looms larger at the near wall). */
    const sum = (s) => s.reduce((a, b) => a + b, 0);
    if (L1.orientation !== 'vertical' && Math.abs(L1.meanY - L2.meanY) > 0.05 * F.height) {
      [near, far] = L1.meanY >= L2.meanY ? [L1, L2] : [L2, L1];
    } else {
      [near, far] = sum(L1.series) >= sum(L2.series) ? [L1, L2] : [L2, L1];
    }
    near.role = 'near';
    far.role = 'far';
    notes.push(`two parallel walls ${(sepFrac * 100).toFixed(0)}% of the frame apart — near y~${near.meanY.toFixed(0)}, far y~${far.meanY.toFixed(0)}.`);
  }

  /* --- events ---------------------------------------------------------- *
     The detector is built for the app's job: a two-length swim, dive to touch.
     It reports events only when it can SEE that structure — a near-wall burst,
     a quiet spell there while the far wall is crossed, then another near-wall
     burst. That alternation is what tells two opposed end walls apart from the
     near and far long sides of the pool (which also read as parallel edges). */
  const nearR = findRises(near.series, steady, F, o);
  const farR = findRises(far.series, steady, F, o);
  near.bandBaseline = nearR.baseline; near.bandPeak = nearR.peak;
  far.bandBaseline = farR.baseline; far.bandPeak = farR.peak;

  const frameSec = 1 / F.fps;
  const unc = (rise) => Math.max(frameSec, rise.halfWidth);
  const quietAt = (R, series, t) => {
    const lo = Math.round((t - o.quietGuardSec) * F.fps);
    const hi = Math.round((t + o.quietGuardSec) * F.fps);
    let m = 0;
    for (let i = Math.max(0, lo); i <= Math.min(series.length - 1, hi); i++) m = Math.max(m, series[i]);
    return m < R.baseline + 0.5 * (R.peak - R.baseline);
  };
  const failAlt = (why) => {
    notes.push(why);
    return withDiag(nullResult(
      'found two parallel edges, but the swimmer does not alternate between them the way a ' +
      `two-length swim would (near burst -> far crossing -> near burst). ${CAMERA_NOTE}`
    ));
  };

  if (nearR.rises.length < 2) {
    return failAlt(`the near edge shows ${nearR.rises.length} motion burst(s) in the steady window, not the two (dive and touch) a two-length swim makes there.`);
  }
  const dRise = nearR.rises[0];
  const tRise = nearR.rises[nearR.rises.length - 1];
  if (tRise.tCross - dRise.tCross < o.minEventGapSec) {
    return failAlt('the near edge\'s first and last bursts are too close to be a dive and a separate touch.');
  }
  // the dive must sit inside the clip, not in the first moment of the steady
  // window (swimmer still walking to the blocks) and the touch not in the last
  // (swimmer climbing out) — those bursts belong to people by the camera, not
  // to a crossing, and they are what a corner shot's near LONG-side edge picks up.
  if (dRise.tCross - steadySpan[0] < o.edgeMarginSec || steadySpan[1] - tRise.tCross < o.edgeMarginSec) {
    notes.push(
      `the near edge's bursts sit at the very ${dRise.tCross - steadySpan[0] < o.edgeMarginSec ? 'start' : 'end'} of the ` +
      'steady window — that is someone entering or leaving the pool by the camera, not a dive or a touch.'
    );
    return withDiag(nullResult(
      'the loudest near-edge motion is at the clip boundary, not inside the swim — the ' +
      'detected edge is the near LONG side of the pool, which people step in and out over. ' + CAMERA_NOTE
    ));
  }
  // the near band must go quiet between the dive and the touch (swimmer is away)
  const nThr = nearR.baseline + 0.4 * (nearR.peak - nearR.baseline);
  let hotMid = 0, totMid = 0;
  const ia = Math.round((dRise.tCross + 1) * F.fps);
  const ib = Math.round((tRise.tCross - 1) * F.fps);
  for (let i = Math.max(0, ia); i <= Math.min(near.series.length - 1, ib); i++) {
    if (!steady[i]) continue;
    totMid++;
    if (near.series[i] > nThr) hotMid++;
  }
  if (totMid > 0 && hotMid / totMid > o.maxMiddleHotFrac) {
    return failAlt(`the near edge is active ${(100 * hotMid / totMid).toFixed(0)}% of the time between its first and last burst — the swimmer never leaves it, so it runs ALONG the swim, not across it.`);
  }
  // a far-wall crossing must sit in that quiet spell, while the near band is quiet
  const midLo = dRise.tCross + 0.3 * o.minEventGapSec;
  const midHi = tRise.tCross - 0.3 * o.minEventGapSec;
  const farMid = farR.rises.filter((r) => r.tCross > midLo && r.tCross < midHi && quietAt(nearR, near.series, r.tCross));
  if (!farMid.length) {
    return failAlt('the far edge shows no isolated crossing while the swimmer is away from the near wall — no turn, so the two edges are not opposite end walls.');
  }

  const mid = 0.5 * (dRise.tCross + tRise.tCross);
  farMid.sort((a, b) => Math.abs(a.tCross - mid) - Math.abs(b.tCross - mid));

  const dive = dRise.tCross, uDive = unc(dRise);
  const touch = tRise.tCross, uTouch = unc(tRise);
  const turn = farMid[0].tCross, uTurn = unc(farMid[0]);

  const outLine = (ln) => ({
    role: ln.role,
    theta: ln.theta,
    rho: ln.rho,
    angleDeg: ln.angleDeg,
    orientation: ln.orientation,
    x1: ln.seg.px + ln.seg.dx * ln.seg.tmin,
    y1: ln.seg.py + ln.seg.dy * ln.seg.tmin,
    x2: ln.seg.px + ln.seg.dx * ln.seg.tmax,
    y2: ln.seg.py + ln.seg.dy * ln.seg.tmax,
    meanY: ln.meanY,
    votes: ln.votes,
    votesNorm: ln.votes / (gmax || 1),
    sideVariance: ln.sideVariance,
    waterContrast: ln.waterContrast,
    waterSide: ln.waterSide,
    bandBaseline: ln.bandBaseline ?? null,
    bandPeak: ln.bandPeak ?? null,
  });

  notes.push(
    `dive at the near wall ${dive.toFixed(2)}s, turn at the far wall ${turn.toFixed(2)}s, ` +
    `touch at the near wall ${touch.toFixed(2)}s.`
  );

  return {
    dive,
    turn,
    touch,
    uncertainty: { dive: uDive, turn: uTurn, touch: uTouch },
    lines: [near, far].map(outLine),
    frameSize,
    notes,
    unfound,
    diagnostics: {
      fps: F.fps,
      frameCount: F.count,
      steadySpan,
      steadyFrames: steadyIdx.length,
      cameraMovedFrac: movedFrac,
      houghMax: gmax,
      candidates: diagCandidates,
    },
  };
}

export default detectLines;
