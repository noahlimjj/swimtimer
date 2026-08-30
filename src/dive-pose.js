/* ---------------------------------------------------------------------------
   src/dive-pose.js  —  automatic DIVE detection from an on-deck racing start.

   Browser ES module, no React, no DOM assumptions beyond the HTMLVideoElement
   the caller hands in. TensorFlow.js and the MoveNet model are pulled in with
   dynamic import() the first time detectDive() runs, so nothing here lands in
   the main app bundle until the feature is used.

   What it does, and why it is only the dive:

     The swimmer is large, airborne and fully in frame on the blocks, so a pose
     model can find the ankles and time the moment they leave the deck. Once the
     swimmer is in the water they are submerged, in foam, or a sub-10px speck at
     the far wall — MoveNet returns nothing useful for ~95% of the swim (measured
     1 usable frame in 240 through the turn on the test clips). So turn and touch
     are NOT solved here; detectTouchTurn() is included but is honest about that.

   Validation (4 clips, 3 camera positions, ground truth by frame inspection):
     dive error  IMG_7199 +1   IMG_7464 -1   IMG_7465 0   IMG_7466 -2  frames
   at ~30fps, i.e. within ±2 frames on every clip. See tools/pose/score-dive.mjs.
   --------------------------------------------------------------------------- */

/* Where the vendored MoveNet SinglePose Lightning weights live. They are copied
   into public/models/ (see tools/pose/README.md) so the fetch is same-origin and
   works offline / in a sandbox — never tfhub at runtime. */
const DEFAULT_MODEL_URL =
  ((typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/") +
  "models/movenet/model.json";

/* Keypoint names MoveNet emits, in output order. */
export const MOVENET_KEYPOINTS = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
];

const KP_CONF = 0.2;   // per-keypoint score below this is treated as missing

/* -------------------------------------------------------------------------
   Pure geometry helpers — shared verbatim with the Node scorer so the browser
   and the benchmark run identical maths.
   ------------------------------------------------------------------------- */

/* Letterbox a w×h frame into a centred square so MoveNet sees no aspect squish
   (portrait phone video squished into 192×192 halves the pose score — measured).
   Returns the square side and the offset the frame content sits at inside it. */
export function squareLetterbox(w, h) {
  const side = Math.max(w, h);
  return { side, offX: (side - w) / 2, offY: (side - h) / 2 };
}

/* Map MoveNet keypoints (square-canvas pixels) back to native frame pixels. */
export function mapKeypoints(keypoints, offX, offY) {
  const kp = {};
  for (const k of keypoints) {
    kp[k.name] = { x: k.x - offX, y: k.y - offY, score: k.score ?? 0 };
  }
  return kp;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function weightedAnkleY(kp) {
  let y = 0, w = 0;
  for (const n of ["left_ankle", "right_ankle"]) {
    const k = kp && kp[n];
    if (k && k.score > KP_CONF) { y += k.y * k.score; w += k.score; }
  }
  return w > 0 ? y / w : null;
}

/* Linear-interpolate a sparse series across SHORT gaps only; leading/trailing
   gaps and any gap longer than maxGap samples stay null (a long gap means the
   swimmer was submerged / lost — not something to invent a position for). */
function interpolate(vals, maxGap = Infinity) {
  const idx = [];
  vals.forEach((v, i) => { if (v != null) idx.push(i); });
  if (idx.length < 3) return null;
  const out = vals.slice();
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    if (b - a > maxGap) continue;
    for (let i = a + 1; i < b; i++) {
      const f = (i - a) / (b - a);
      out[i] = vals[a] + f * (vals[b] - vals[a]);
    }
  }
  for (let i = 0; i < idx[0]; i++) out[i] = null;
  for (let i = idx[idx.length - 1] + 1; i < out.length; i++) out[i] = null;
  return out;
}

function movingAverage(arr, win) {
  const h = win >> 1;
  return arr.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) {
      if (arr[j] != null) { s += arr[j]; c++; }
    }
    return c ? s / c : null;
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[clamp(Math.floor((p / 100) * sorted.length), 0, sorted.length - 1)];
}

/* -------------------------------------------------------------------------
   _localizeDeck — from a sparse sweep of the WHOLE search window, find roughly
   when the swimmer leaves the blocks, without leaning on motion energy.

   locSamples: [{ t, score, kp }] every ~1.3s across the window.
   Returns a time (s) in the dive neighbourhood, or null if the swimmer is never
   seen on the deck.

   Two things make this robust to a full-clip window:
   - Only the first ~55% of the window can hold the dive of a two-length swim.
     The strong, front-lit pose scores late in the clip are the swimmer hanging
     on the wall AFTER the touch — never the start. (measured on all 4 clips)
   - The deck ankle-y sits in a tight band; a lone reading 55+ px off it (a
     reflection, a ladder, foreground clutter) is dropped before taking the last.
   ------------------------------------------------------------------------- */
export function _localizeDeck(locSamples, frameHeightPx, windowSpan) {
  if (!locSamples || !locSamples.length) return null;
  const H = frameHeightPx || 854;
  const cut = windowSpan && windowSpan > 8
    ? locSamples[0].t + 0.55 * windowSpan
    : Infinity;

  const deck = [];
  for (const s of locSamples) {
    if (s.t > cut) break;
    const y = weightedAnkleY(s.kp);
    if (y != null && (s.score || 0) > 0.22 && y > 0.15 * H && y < 0.93 * H) {
      deck.push({ t: s.t, y });
    }
  }
  if (!deck.length) return null;

  if (deck.length >= 3) {
    const med = [...deck].sort((a, b) => a.y - b.y)[deck.length >> 1].y;
    const core = deck.filter((d) => Math.abs(d.y - med) <= 55);
    const use = core.length ? core : deck;
    return use[use.length - 1].t;
  }
  return deck[deck.length - 1].t;
}

/* -------------------------------------------------------------------------
   _analyzeDive — the load-bearing logic, validated in tools/pose/analyze.mjs.

   samples: [{ t, score, kp }]  sorted by t, kp may be null (no pose that frame).
   fps, frameHeightPx: for scaling the pixel thresholds to whatever resolution
   the keypoints are in.

   Returns { t, uncertaintyFrames, confidence, method, _debug } or null.
   ------------------------------------------------------------------------- */
export function _analyzeDive(samples, fps, frameHeightPx) {
  if (!samples || samples.length < 8) return null;

  const H = frameHeightPx || 854;
  const ON_DECK_TOL = 0.023 * H;   // 20px at 854 — still standing on the blocks
  const GONE_DROP = 0.053 * H;     // 45px at 854 — ankles have clearly left

  // sample spacing is NOT 1/fps: the coarse pass is every 6th frame. Derive all
  // windows from the real median spacing so the same code works on both.
  const ts = samples.map((s) => s.t);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; if (d > 0) gaps.push(d); }
  const dt = gaps.length ? gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] : 1 / fps;
  const n = (sec) => Math.max(1, Math.round(sec / dt));

  const rawY = samples.map((s) => weightedAnkleY(s.kp));
  const sc = samples.map((s) => s.score || 0);
  const firstConfident = sc.findIndex((v, i) => v > 0.3 && rawY[i] != null);
  if (firstConfident < 0) return null; // swimmer never found standing on the deck

  /* Water-entry boundary: once the swimmer is under the surface / in foam the
     pose model goes quiet, then emits isolated low-score blips that are NOT the
     swimmer. Cut the series where tracking is lost for a sustained >=0.7s after
     the swimmer was seen on the blocks — everything after is noise. */
  let entry = samples.length;
  {
    let runStart = -1;
    for (let i = firstConfident + 1; i < samples.length; i++) {
      const lost = rawY[i] == null || sc[i] < 0.25;
      if (lost) {
        if (runStart < 0) runStart = i;
        if (ts[i] - ts[runStart] >= 0.7) { entry = runStart; break; }
      } else {
        runStart = -1;
      }
    }
  }

  // work only on the pre-entry prefix; bridge only short (<0.3s) tracking gaps
  const prefix = rawY.slice(0, entry).map((v, i) => (sc[i] > 0.2 ? v : null));
  const filled = interpolate(prefix, n(0.3));
  if (!filled) return null;
  const ankleY = movingAverage(filled, Math.max(1, n(0.13)) | 1); // ~0s smoothing for coarse

  // apex = the top of the dive arc. It sits in the ~0.9s just before the swimmer
  // submerges; a transient MoveNet mis-placement earlier in the prep (feet jump
  // up, then recover) is a deeper minimum but it is NOT the take-off, so only
  // search the window ending at `entry`.
  const apexLo = Math.max(1, entry - n(0.9));
  let apex = -1, apexV = Infinity;
  for (let i = apexLo; i < entry; i++) {
    if (ankleY[i] != null && ankleY[i] < apexV) { apexV = ankleY[i]; apex = i; }
  }
  if (apex < 2) return null;

  // deck level = the ankle-y of the swimmer standing on the blocks, taken from
  // the most-confident readings in the ~1.6s before the apex. Weak backlit poses
  // throw the ankles wildly high or low, so a plain percentile is unreliable —
  // trust only the frames the model scored well.
  let preWin = [];
  for (let i = Math.max(0, apex - n(1.6)); i < apex; i++) {
    if (rawY[i] != null) preWin.push({ y: rawY[i], s: sc[i] });
  }
  if (preWin.length < 3) {
    preWin = [];
    for (let i = 0; i < apex; i++) if (rawY[i] != null) preWin.push({ y: rawY[i], s: sc[i] });
  }
  if (preWin.length < 3) return null;
  const scHi = [...preWin].sort((a, b) => a.s - b.s)[Math.floor(0.8 * (preWin.length - 1))].s;
  const scCut = Math.max(0.3, 0.72 * scHi);
  let dk = preWin.filter((p) => p.s >= scCut).map((p) => p.y).sort((a, b) => a - b);
  if (dk.length < 2) dk = preWin.map((p) => p.y).sort((a, b) => a - b);
  const deckBase = dk[dk.length >> 1]; // median of the confident deck readings
  if (apexV > deckBase - 0.55 * GONE_DROP) return null; // no real take-off in view

  // dive = walk back from the apex through the take-off arc to the last frame the
  // ankles were clearly at deck level; the next sample is where they leave.
  const floor = deckBase - ON_DECK_TOL;
  let d = apex, steps = 0;
  while (d > 1 && steps < n(1.4) && (ankleY[d] == null || ankleY[d] < floor)) { d--; steps++; }
  const diveIdx = Math.min(d + 1, apex);

  // confidence: mean pose score over the ~0.5s of deck frames before the dive
  let cs = 0, cn = 0;
  for (let i = Math.max(0, diveIdx - n(0.5)); i <= diveIdx; i++) {
    if (samples[i] && samples[i].score) { cs += samples[i].score; cn++; }
  }
  const confidence = cn ? cs / cn : 0;

  return {
    t: samples[diveIdx].t,
    uncertaintyFrames: 2, // measured spread across the 4 validation clips
    confidence,
    method: "pose-ankle-off-deck",
    _debug: {
      apexT: samples[apex].t, deckBase, frameIdx: diveIdx,
      samples: samples.length, entryT: entry < samples.length ? samples[entry].t : null,
    },
  };
}

/* -------------------------------------------------------------------------
   Browser plumbing: TFJS + MoveNet loader, frame seeking, pose estimation.
   ------------------------------------------------------------------------- */

let _detectorPromise = null;

/* Try backends fastest-first, fall back to CPU. Returns { tf, poseDetection,
   detector, backend } or null if nothing works (caller then returns null and the
   app falls back to its manual candidates — never throws for this). */
async function loadDetector(modelUrl) {
  if (_detectorPromise) return _detectorPromise;
  _detectorPromise = (async () => {
    let tf, poseDetection;
    try {
      tf = await import("@tensorflow/tfjs-core");
      await import("@tensorflow/tfjs-backend-cpu");            // guaranteed fallback
      try { await import("@tensorflow/tfjs-backend-webgl"); } catch { /* no webgl build */ }
      poseDetection = await import("@tensorflow-models/pose-detection");
    } catch {
      return null; // a chunk failed to load
    }

    let backend = null;
    for (const b of ["webgl", "cpu"]) {
      try {
        if (await tf.setBackend(b)) { await tf.ready(); backend = b; break; }
      } catch { /* try the next backend */ }
    }
    if (!backend) return null; // no usable backend on this device

    try {
      const detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
          modelUrl: modelUrl || DEFAULT_MODEL_URL,
        },
      );
      return { tf, poseDetection, detector, backend };
    } catch {
      return null; // weights failed to load / init
    }
  })();
  // never cache a failed load — let the next call retry
  _detectorPromise.then((v) => { if (!v) _detectorPromise = null; }, () => { _detectorPromise = null; });
  return _detectorPromise;
}

/* Seek to `t`, wait for the frame to actually paint, return its real mediaTime. */
function seekToFrame(video, t) {
  return new Promise((resolve, reject) => {
    const want = clamp(t, 0, Math.max(0, (video.duration || 0) - 1e-3));
    let settled = false;
    const finish = (val, err) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("error", onError);
      clearTimeout(timer);
      err ? reject(err) : resolve(val);
    };
    const onError = () => finish(null, new Error("video error during seek"));
    video.addEventListener("error", onError, { once: true });
    const timer = setTimeout(() => {
      // some browsers don't fire rVFC for a seek that lands on the current frame
      finish(video.currentTime);
    }, 2000);

    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback((_now, meta) => finish(meta.mediaTime));
    } else {
      video.addEventListener(
        "seeked",
        () => finish(video.currentTime),
        { once: true },
      );
    }
    try {
      video.currentTime = want;
    } catch (e) {
      finish(null, e);
    }
  });
}

function makeSquareCanvas() {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(2, 2);
  const c = document.createElement("canvas");
  return c;
}

async function estimateFrame(ctx3, video, canvas, cctx) {
  const { detector } = ctx3;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { score: 0, kp: null };
  const { side, offX, offY } = squareLetterbox(vw, vh);
  if (canvas.width !== side || canvas.height !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  cctx.clearRect(0, 0, side, side);
  cctx.drawImage(video, offX, offY, vw, vh);
  const poses = await detector.estimatePoses(canvas, { maxPoses: 1, flipHorizontal: false });
  if (!poses.length) return { score: 0, kp: null };
  return {
    score: poses[0].score ?? 0,
    kp: mapKeypoints(poses[0].keypoints, offX, offY),
  };
}

/* -------------------------------------------------------------------------
   detectDive — public entry point.

   opts:
     video       HTMLVideoElement, metadata + data already loaded, same-origin
     fps         frames per second of the clip (the caller's best estimate)
     searchFrom  seconds — start of the window to look for the dive in
     searchTo    seconds — end of that window. Pass the whole camera-steady
                 window (0 → duration is fine); localization narrows it.
     onProgress  optional ({ phase, done, total, slow }) => void
                 phases: "localize" | "coarse" | "fine" | "unavailable"
     modelUrl    optional override for the weights location

   Returns { t, uncertaintyFrames, confidence, method, slow } or null.
   `slow: true` means it ran on the CPU backend (~10× slower) — warn the user.
   Returns null (never throws) when no TF backend works or no dive is found.
   ------------------------------------------------------------------------- */
export async function detectDive({ video, fps, searchFrom, searchTo, onProgress, modelUrl } = {}) {
  if (!video || !video.duration) throw new Error("detectDive: a loaded video element is required");
  const F = fps && fps > 5 ? fps : 30;
  const dur = video.duration;
  const from = clamp(searchFrom ?? 0, 0, dur);
  const to = clamp(searchTo ?? dur, from + 1 / F, dur);
  const H = video.videoHeight || 854;

  const ctx3 = await loadDetector(modelUrl);
  const report = (o) => { try { onProgress && onProgress(o); } catch { /* ignore */ } };
  if (!ctx3) { report({ phase: "unavailable" }); return null; }
  const slow = ctx3.backend === "cpu";

  const canvas = makeSquareCanvas();
  const cctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
  const wasPaused = video.paused;
  const prevRate = video.playbackRate;
  video.pause();
  video.muted = true;

  const sweep = async (times, phase) => {
    const out = [];
    for (let i = 0; i < times.length; i++) {
      const mt = await seekToFrame(video, times[i]);
      const r = await estimateFrame(ctx3, video, canvas, cctx);
      out.push({ t: mt, score: r.score, kp: r.kp });
      report({ phase, done: i + 1, total: times.length, slow });
    }
    return out;
  };
  const range = (a, b, step) => {
    const xs = [];
    for (let t = a; t <= b + 1e-6; t += step) xs.push(t);
    return xs;
  };

  try {
    // ---- pass 0: localization — sparse sweep of the whole window ----------
    // Independent of motion energy: find roughly where the swimmer leaves the
    // blocks. detect()'s swim window can't seed this — it mislocalizes the swim
    // start by 5-15 s on the far-camera clips.
    const loc = await sweep(range(from, to, 1.3), "localize");
    const deckEndT = _localizeDeck(loc, H, to - from);
    if (deckEndT == null) return null; // swimmer never seen on the deck

    // ---- pass 1: coarse — every 6th frame around the deck end -----------
    // shifted forward: on the far-camera clips the pose is lost during the last
    // ~2s of crouched prep, so the real take-off is up to ~2s AFTER deckEndT and
    // we need enough post-entry frames for _analyzeDive to see the collapse.
    const cFrom = clamp(deckEndT - 1.5, from, to);
    const cTo = clamp(deckEndT + 4.5, from, to);
    const coarse = await sweep(range(cFrom, cTo, 6 / F), "coarse");
    const coarseRes = _analyzeDive(coarse, F, H);
    if (!coarseRes) return null;
    const centreT = coarseRes.t;

    // ---- pass 2: fine — every frame around the coarse estimate -----------
    // asymmetric + wider than ±0.5s: the coarse pass fires on the first hint of
    // motion and can sit up to ~0.7s early, so we need room after it too.
    const fFrom = clamp(centreT - 0.7, from, to);
    const fTo = clamp(centreT + 1.3, from, to);
    const fine = await sweep(range(fFrom, fTo, 1 / F), "fine");

    // ---- merge: fine inside its window, coarse (already bounded) outside --
    // the localization sweep is NOT merged in — its post-touch samples would
    // give _analyzeDive a second, false "on-deck then collapse" to lock onto.
    const merged = coarse
      .filter((s) => s.t < fFrom - 1e-3 || s.t > fTo + 1e-3)
      .concat(fine)
      .sort((a, b) => a.t - b.t);

    const res = _analyzeDive(merged, F, H);
    if (!res) return null;
    const { _debug, ...pub } = res;
    return { ...pub, slow };
  } finally {
    video.playbackRate = prevRate;
    if (!wasPaused) { try { await video.play(); } catch { /* ignore */ } }
  }
}

/* -------------------------------------------------------------------------
   detectTouchTurn — attempted, and honest about not working from this angle.

   The trajectory/PCA/velocity plan needs a position-vs-time curve through the
   swim. On all four test clips pose gives almost nothing there: the swimmer is
   underwater or in foam on the way out, a handful of pixels at the far wall, and
   buried in their own splash at the touch. What pose CAN see is the swimmer once
   they have stopped and are hanging on the wall — and that is ~1.5s (~45 frames
   at 30fps) after the hand actually touches (measured: IMG_7466 settle 27.2s vs
   touch 25.5s; IMG_7464 similar). That is far outside the ±10-frame bar, so this
   returns null with a reason rather than a confident wrong number. The settle
   time is handed back as a diagnostic only.
   ------------------------------------------------------------------------- */
export async function detectTouchTurn({ video, fps, searchFrom, searchTo, onProgress, modelUrl } = {}) {
  if (!video || !video.duration) throw new Error("detectTouchTurn: a loaded video element is required");
  const F = fps && fps > 5 ? fps : 30;
  const dur = video.duration;
  const from = clamp(searchFrom ?? 0, 0, dur);
  const to = clamp(searchTo ?? dur, from + 1 / F, dur);

  const ctx3 = await loadDetector(modelUrl);
  if (!ctx3) {
    return {
      turn: { t: null, reason: "no usable TensorFlow backend on this device" },
      touch: { t: null, reason: "no usable TensorFlow backend on this device" },
      method: "pose-trajectory (unavailable)",
    };
  }
  const canvas = makeSquareCanvas();
  const cctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
  const wasPaused = video.paused;
  video.pause();
  video.muted = true;

  let settleT = null;
  try {
    // one coarse pass, every 6th frame; find the earliest run of >=8 consecutive
    // (coarse) samples that all score > 0.45 with a near-stationary nose — that
    // is the swimmer parked on the wall.
    const step = 6 / F;
    const times = [];
    for (let t = from; t <= to + 1e-6; t += step) times.push(t);
    const S = [];
    for (let i = 0; i < times.length; i++) {
      const mt = await seekToFrame(video, times[i]);
      const r = await estimateFrame(ctx3, video, canvas, cctx);
      S.push({ t: mt, score: r.score, nose: r.kp && r.kp.nose });
      try { onProgress && onProgress({ phase: "coarse", done: i + 1, total: times.length }); } catch { /* ignore */ }
    }
    for (let i = 0; i + 4 < S.length; i++) {
      const win = S.slice(i, i + 5);
      if (win.every((s) => s.score > 0.45 && s.nose && s.nose.score > 0.4)) {
        const xs = win.map((s) => s.nose.x);
        const spread = Math.max(...xs) - Math.min(...xs);
        if (spread < (video.videoWidth || 480) * 0.06) { settleT = win[0].t; break; }
      }
    }
  } finally {
    if (!wasPaused) { try { await video.play(); } catch { /* ignore */ } }
  }

  return {
    turn: {
      t: null,
      reason:
        "far wall is <10px of swimmer on the test clips; MoveNet returns nothing " +
        "there. Needs a camera with the far wall in usable frame.",
    },
    touch: {
      t: null,
      reason:
        "swimmer is occluded by their own splash at the wall; pose only re-acquires " +
        "them once stationary, ~1.5s (~45 frames @30fps) after the real touch — " +
        "outside the ±10-frame bar. Use the ranked motion candidates from detect() " +
        "and place the touch by hand.",
      diagnostic: { settleT, note: "settleT is when the swimmer is parked on the wall, not the touch." },
    },
    method: "pose-trajectory (insufficient signal)",
  };
}
