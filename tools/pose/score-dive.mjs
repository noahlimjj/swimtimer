#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   score-dive.mjs — score src/dive-pose.js's dive detector against the 4 clips.

   Runs the SAME logic the browser module uses:
     - the same square-letterbox padding  (squareLetterbox / mapKeypoints)
     - the same MoveNet SinglePose Lightning weights vendored in public/models/
     - the same two-pass structure (coarse every 6th frame; then _analyzeDive on
       the coarse samples picks a centre, and the fine pass runs every frame
       from 0.7s before to 1.3s after it)
     - the exact same _analyzeDive() imported from ../../src/dive-pose.js

   Only the runtime differs: tfjs-node here vs tfjs-backend-webgl in the browser,
   and frames come from an ffmpeg rawvideo pipe instead of <video> seeks.

   Usage:  node tools/pose/score-dive.mjs [clipDir]
           clipDir defaults to /Users/User/Downloads/files
   --------------------------------------------------------------------------- */
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tf from "@tensorflow/tfjs-node";
import * as poseDetection from "@tensorflow-models/pose-detection";
import { _analyzeDive, _localizeDeck, squareLetterbox, mapKeypoints } from "../../src/dive-pose.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_URL =
  "file://" + path.resolve(HERE, "../../public/models/movenet/model.json");
const CLIP_DIR = process.argv[2] || "/Users/User/Downloads/files";

// analysis resolution — fractional thresholds in _analyzeDive make this
// independent of the browser's native-resolution keypoints.
const W = 480, H = 854;

// ground truth (frame-by-frame human inspection, from the task brief)
const GT = {
  // dive is a bracket where frame inspection couldn't call a single frame; error
  // is measured to the nearer edge (0 if inside).
  IMG_7199: { dive: 1.05, bracket: [1.03, 1.07] },
  IMG_7464: { dive: 12.750, bracket: [12.72, 12.78] },
  IMG_7465: { dive: 2.234, bracket: [2.20, 2.27] },
  IMG_7466: { dive: 12.500, bracket: [12.47, 12.53] },
};

function probe(clip) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=duration,nb_frames",
    "-of", "json", clip,
  ], { encoding: "utf8" });
  const s = JSON.parse(r.stdout).streams[0];
  return { dur: parseFloat(s.duration), nbf: parseInt(s.nb_frames, 10) };
}

/* Exact presentation time of every frame (matches what the browser's
   requestVideoFrameCallback reports as meta.mediaTime). */
function framePts(clip) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=best_effort_timestamp_time",
    "-of", "csv=p=0", clip,
  ], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout.trim().split("\n")
    .map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
}

/* Stream-decode the whole clip at W×H rgb24, keeping frames whose presentation
   time is inside [from,to]. If step>0, keep only the frame nearest each multiple
   of `step` seconds (the sparse localization sweep). Streaming so we never
   buffer >2GB. */
function decodeWindow(clip, pts, from, to, step = 0) {
  return new Promise((resolve, reject) => {
    const frameBytes = W * H * 3;
    const ff = spawn("ffmpeg", [
      "-v", "error", "-i", clip,
      "-vf", `scale=${W}:${H},format=rgb24`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let acc = Buffer.alloc(0);
    let idx = 0;
    let nextTick = from;
    const out = [];
    ff.stdout.on("data", (chunk) => {
      acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
      while (acc.length >= frameBytes) {
        const frame = acc.subarray(0, frameBytes);
        acc = acc.subarray(frameBytes);
        const t = pts[idx] ?? idx / 30;
        idx++;
        if (t < from || t > to) continue;
        if (step > 0) {
          if (t + 1e-9 < nextTick) continue;
          out.push({ t, buf: Buffer.from(frame) });
          nextTick += step;
        } else {
          out.push({ t, buf: Buffer.from(frame) });
        }
      }
    });
    let err = "";
    ff.stderr.on("data", (d) => { err += d; });
    ff.on("close", (code) => code === 0 ? resolve(out) : reject(new Error("ffmpeg: " + err)));
  });
}

async function makeDetector() {
  await tf.ready();
  return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    modelUrl: MODEL_URL,
  });
}

async function estimate(detector, buf) {
  // buf is W×H rgb24; letterbox into a square exactly like the browser canvas
  const { side, offX, offY } = squareLetterbox(W, H);
  const r = await tf.tidy(() => {
    const img = tf.tensor3d(new Uint8Array(buf), [H, W, 3], "int32");
    const padded = img.pad([
      [Math.floor(offY), Math.ceil(offY)],
      [Math.floor(offX), Math.ceil(offX)],
      [0, 0],
    ]);
    return padded;
  });
  const poses = await detector.estimatePoses(r, { maxPoses: 1, flipHorizontal: false });
  r.dispose();
  if (!poses.length) return { score: 0, kp: null };
  return { score: poses[0].score ?? 0, kp: mapKeypoints(poses[0].keypoints, offX, offY) };
}

async function run() {
  const detector = await makeDetector();
  const rows = [];
  const times = [];

  for (const [name, gt] of Object.entries(GT)) {
    const clip = path.join(CLIP_DIR, name + ".mov");
    const { dur } = probe(clip);
    const pts = framePts(clip);
    const fps = pts.length > 1 ? (pts.length - 1) / (pts[pts.length - 1] - pts[0]) : 30;

    // App hands the WHOLE camera-steady window (here: the whole clip).
    const from = 0, to = dur;

    const est = async (buf) => {
      const t0 = performance.now();
      const r = await estimate(detector, buf);
      times.push(performance.now() - t0);
      return r;
    };

    // ---- pass 0: localization — sparse sweep of the whole clip ----
    const locFrames = await decodeWindow(clip, pts, from, to, 1.3);
    const loc = [];
    for (const fr of locFrames) {
      const r = await est(fr.buf);
      loc.push({ t: fr.t, score: r.score, kp: r.kp });
    }
    const deckEndT = _localizeDeck(loc, H, to - from);
    if (deckEndT == null) {
      rows.push({ name, fps: fps.toFixed(3), gt: gt.dive, det: null, errFrames: null, conf: "-", poses: loc.length, centreT: "-" });
      continue;
    }

    // ---- pass 1 + 2: coarse (deckEndT -1.5 .. +4.5) then fine ----
    const region = await decodeWindow(clip, pts, Math.max(0, deckEndT - 1.7), Math.min(dur, deckEndT + 6.2), 0);
    const cLo = deckEndT - 1.5, cHi = deckEndT + 4.5;
    const coarse = [];
    let ci = 0;
    for (const fr of region) {
      if (fr.t < cLo - 1e-3 || fr.t > cHi + 1e-3) continue;
      if (ci++ % 6 !== 0) continue;
      const r = await est(fr.buf);
      coarse.push({ t: fr.t, score: r.score, kp: r.kp });
    }
    const coarseRes = _analyzeDive(coarse, fps, H);
    const centreT = coarseRes ? coarseRes.t : deckEndT;

    const fineLo = centreT - 0.7, fineHi = centreT + 1.3;
    const fine = [];
    for (const fr of region) {
      if (fr.t < fineLo - 1e-3 || fr.t > fineHi + 1e-3) continue;
      const r = await est(fr.buf);
      fine.push({ t: fr.t, score: r.score, kp: r.kp });
    }

    // match src/dive-pose.js detectDive exactly: the localization sweep is NOT
    // merged in (its far-from-dive samples give _analyzeDive a false on-deck).
    const merged = coarse
      .filter((s) => s.t < fineLo - 1e-3 || s.t > fineHi + 1e-3)
      .concat(fine)
      .sort((a, b) => a.t - b.t);

    const res = _analyzeDive(merged, fps, H);
    if (process.env.DBG) {
      console.log(`\n--- ${name}  centreT=${centreT.toFixed(2)}  merged=${merged.length}`);
      for (const s of merged) {
        const y = ankleY(s.kp);
        console.log(`  t=${s.t.toFixed(3)} score=${s.score.toFixed(2)} ankleY=${y == null ? "  .  " : y.toFixed(0)}`);
      }
      console.log("  _analyzeDive:", JSON.stringify(res));
    }
    const detT = res ? res.t : null;
    let errFrames = null;
    if (detT != null) {
      const [lo, hi] = gt.bracket || [gt.dive, gt.dive];
      const off = detT < lo ? detT - lo : detT > hi ? detT - hi : 0;
      errFrames = Math.round(off * fps);
    }
    rows.push({
      name, fps: fps.toFixed(3), gt: gt.dive, det: detT, errFrames,
      conf: res ? res.confidence.toFixed(2) : "-",
      poses: merged.length, centreT: centreT.toFixed(2),
    });
  }

  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const sorted = times.slice().sort((a, b) => a - b);
  console.log("\n  clip        fps      GT dive   detected   err(frames)  conf  poses");
  console.log("  " + "-".repeat(70));
  for (const r of rows) {
    console.log(
      `  ${r.name}   ${r.fps}   ${String(r.gt).padStart(7)}s   ` +
      `${r.det == null ? "   null  " : (r.det.toFixed(3) + "s")}   ` +
      `${r.errFrames == null ? " n/a" : String(r.errFrames).padStart(4)}` +
      `          ${r.conf}   ${r.poses}`);
  }
  console.log("  " + "-".repeat(70));
  console.log(`  inference: ${times.length} frames, mean ${mean.toFixed(1)} ms, ` +
    `median ${sorted[sorted.length >> 1].toFixed(1)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(1)} ms`);
  const worst = Math.max(...rows.filter((r) => r.errFrames != null).map((r) => Math.abs(r.errFrames)));
  console.log(`  worst |error| = ${worst} frame(s)  ->  ${worst <= 2 ? "PASS" : "FAIL"} (bar: dive ±2)\n`);
}

function ankleY(kp) {
  let y = 0, w = 0;
  for (const n of ["left_ankle", "right_ankle"]) {
    const k = kp && kp[n];
    if (k && k.score > 0.2) { y += k.y * k.score; w += k.score; }
  }
  return w > 0 ? y / w : null;
}

run().catch((e) => { console.error(e); process.exit(1); });
