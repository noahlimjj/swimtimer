#!/usr/bin/env node
/* Debug a single clip's dive detection — dump the ankle-Y trace around the dive. */
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tf from "@tensorflow/tfjs-node";
import * as poseDetection from "@tensorflow-models/pose-detection";
import { _analyzeDive, _localizeDeck, squareLetterbox, mapKeypoints } from "../../src/dive-pose.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_URL = "file://" + path.resolve(HERE, "../../public/models/movenet/model.json");
const CLIP_DIR = process.argv[3] || "/Users/User/Downloads/files";
const CLIP_NAME = process.argv[2] || "IMG_7465";

const W = 480, H = 854;

function probe(clip) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=duration,nb_frames", "-of", "json", clip], { encoding: "utf8" });
  const s = JSON.parse(r.stdout).streams[0];
  return { dur: parseFloat(s.duration), nbf: parseInt(s.nb_frames, 10) };
}

function framePts(clip) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", clip],
    { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.stdout.trim().split("\n").map(x => parseFloat(x)).filter(x => Number.isFinite(x));
}

function decodeWindow(clip, pts, from, to, step = 0) {
  return new Promise((resolve, reject) => {
    const frameBytes = W * H * 3;
    const ff = spawn("ffmpeg", ["-v", "error", "-i", clip,
      "-vf", `scale=${W}:${H},format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { stdio: ["ignore", "pipe", "pipe"] });
    let acc = Buffer.alloc(0);
    let idx = 0, nextTick = from;
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
    ff.stderr.on("data", d => { err += d; });
    ff.on("close", code => code === 0 ? resolve(out) : reject(new Error("ffmpeg: " + err)));
  });
}

function ankleY(kp) {
  let y = 0, w = 0;
  for (const n of ["left_ankle", "right_ankle"]) {
    const k = kp && kp[n];
    if (k && k.score > 0.2) { y += k.y * k.score; w += k.score; }
  }
  return w > 0 ? y / w : null;
}

async function run() {
  await tf.ready();
  const detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    modelUrl: MODEL_URL,
  });

  const clip = path.join(CLIP_DIR, CLIP_NAME + ".mov");
  const { dur } = probe(clip);
  const pts = framePts(clip);
  const fps = pts.length > 1 ? (pts.length - 1) / (pts[pts.length - 1] - pts[0]) : 30;
  console.log(`Clip: ${CLIP_NAME}  dur=${dur.toFixed(2)}s  fps=${fps.toFixed(3)}  frames=${pts.length}`);

  const estimate = async (buf) => {
    const { side, offX, offY } = squareLetterbox(W, H);
    const r = await tf.tidy(() => {
      const img = tf.tensor3d(new Uint8Array(buf), [H, W, 3], "int32");
      return img.pad([[Math.floor(offY), Math.ceil(offY)], [Math.floor(offX), Math.ceil(offX)], [0, 0]]);
    });
    const poses = await detector.estimatePoses(r, { maxPoses: 1, flipHorizontal: false });
    r.dispose();
    if (!poses.length) return { score: 0, kp: null };
    return { score: poses[0].score ?? 0, kp: mapKeypoints(poses[0].keypoints, offX, offY) };
  };

  // pass 0: localization
  const from = 0, to = dur;
  const locFrames = await decodeWindow(clip, pts, from, to, 1.3);
  const loc = [];
  for (const fr of locFrames) {
    const r = await estimate(fr.buf);
    loc.push({ t: fr.t, score: r.score, kp: r.kp });
  }
  const deckEndT = _localizeDeck(loc, H, to - from);
  console.log(`\nLocalization: deckEndT = ${deckEndT?.toFixed(3) ?? "null"}`);
  console.log("Loc samples with ankles:");
  for (const s of loc) {
    const y = ankleY(s.kp);
    if (y != null) console.log(`  t=${s.t.toFixed(3)}  score=${s.score.toFixed(3)}  ankleY=${y.toFixed(1)}`);
  }

  if (deckEndT == null) { console.log("No deck found."); return; }

  // pass 1: coarse
  const region = await decodeWindow(clip, pts, Math.max(0, deckEndT - 1.7), Math.min(dur, deckEndT + 6.2), 0);
  const cLo = deckEndT - 1.5, cHi = deckEndT + 4.5;
  const coarse = [];
  let ci = 0;
  for (const fr of region) {
    if (fr.t < cLo - 1e-3 || fr.t > cHi + 1e-3) continue;
    if (ci++ % 6 !== 0) continue;
    const r = await estimate(fr.buf);
    coarse.push({ t: fr.t, score: r.score, kp: r.kp });
  }
  const coarseRes = _analyzeDive(coarse, fps, H);
  const centreT = coarseRes ? coarseRes.t : deckEndT;
  console.log(`\nCoarse: centreT=${centreT.toFixed(3)}  coarseRes=${JSON.stringify(coarseRes?._debug)}`);

  // pass 2: fine
  const fineLo = centreT - 0.7, fineHi = centreT + 1.3;
  const fine = [];
  for (const fr of region) {
    if (fr.t < fineLo - 1e-3 || fr.t > fineHi + 1e-3) continue;
    const r = await estimate(fr.buf);
    fine.push({ t: fr.t, score: r.score, kp: r.kp });
  }

  const merged = loc
    .concat(coarse)
    .filter(s => s.t < fineLo - 1e-3 || s.t > fineHi + 1e-3)
    .concat(fine)
    .sort((a, b) => a.t - b.t);

  console.log(`\nFine window: ${fineLo.toFixed(3)} - ${fineHi.toFixed(3)}  (${fine.length} frames)`);
  console.log("\nMerged trace around dive (±2s of centreT):");
  for (const s of merged) {
    if (s.t < centreT - 2.5 || s.t > centreT + 3.0) continue;
    const y = ankleY(s.kp);
    const la = s.kp?.left_ankle;
    const ra = s.kp?.right_ankle;
    console.log(
      `  t=${s.t.toFixed(3)}  score=${s.score.toFixed(2)}  ankleY=${y == null ? "  .  " : y.toFixed(1).padStart(6)}` +
      `  L_ank=${la ? `(${la.y.toFixed(0)},${la.score.toFixed(2)})` : "  -  "}` +
      `  R_ank=${ra ? `(${ra.y.toFixed(0)},${ra.score.toFixed(2)})` : "  -  "}`
    );
  }

  const res = _analyzeDive(merged, fps, H);
  console.log(`\nFinal: ${JSON.stringify(res)}`);
}

run().catch(e => { console.error(e); process.exit(1); });
