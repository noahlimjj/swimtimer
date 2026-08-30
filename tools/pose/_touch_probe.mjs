/* Probe: measure settleT (swimmer goes stationary on the near wall) vs GT touch.
   node tools/pose/_touch_probe.mjs */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import * as tf from "@tensorflow/tfjs-node";
import * as pd from "@tensorflow-models/pose-detection";
import { squareLetterbox, mapKeypoints } from "../../src/dive-pose.js";

const W = 480, H = 854;
const MODEL = "file://" + path.resolve("/Users/User/swim_timer/public/models/movenet/model.json");
const GT = {
  IMG_7199: { touch: null, dive: 1.05 },
  IMG_7464: { touch: 25.85, dive: 12.75 },
  IMG_7465: { touch: 15.20, dive: 2.234 },
  IMG_7466: { touch: 25.52, dive: 12.50 },
};
const STEP = 0.4;

function pts(clip) {
  return spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "frame=best_effort_timestamp_time", "-of", "csv=p=0", clip],
    { encoding: "utf8", maxBuffer: 1 << 26 }).stdout.trim().split("\n").map(parseFloat).filter(Number.isFinite);
}
function dur(clip) {
  return parseFloat(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=duration", "-of", "csv=p=0", clip], { encoding: "utf8" }).stdout);
}
function grab(clip, P, from, step) {
  return new Promise((res, rej) => {
    const fb = W * H * 3;
    const ff = spawn("ffmpeg", ["-v", "error", "-i", clip, "-vf", `scale=${W}:${H},format=rgb24`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    let acc = Buffer.alloc(0), idx = 0, next = from;
    const out = [];
    ff.stdout.on("data", (c) => {
      acc = acc.length ? Buffer.concat([acc, c]) : c;
      while (acc.length >= fb) {
        const fr = acc.subarray(0, fb); acc = acc.subarray(fb);
        const t = P[idx] ?? idx / 30; idx++;
        if (t >= from && t + 1e-9 >= next) { out.push({ t, buf: Buffer.from(fr) }); next += step; }
      }
    });
    let e = ""; ff.stderr.on("data", (d) => e += d);
    ff.on("close", (c) => c === 0 ? res(out) : rej(new Error(e)));
  });
}
const det = await pd.createDetector(pd.SupportedModels.MoveNet, {
  modelType: pd.movenet.modelType.SINGLEPOSE_LIGHTNING, modelUrl: MODEL,
});
const { offX, offY } = squareLetterbox(W, H);
async function est(buf) {
  const r = tf.tidy(() => tf.tensor3d(new Uint8Array(buf), [H, W, 3], "int32")
    .pad([[Math.floor(offY), Math.ceil(offY)], [Math.floor(offX), Math.ceil(offX)], [0, 0]]));
  const p = await det.estimatePoses(r, { maxPoses: 1 }); r.dispose();
  if (!p.length) return { s: 0, kp: null };
  return { s: p[0].score ?? 0, kp: mapKeypoints(p[0].keypoints, offX, offY) };
}

const results = [];
for (const [name, gt] of Object.entries(GT)) {
  const clip = `/Users/User/Downloads/files/${name}.mov`;
  const P = pts(clip), D = dur(clip);
  const from = gt.dive + 3; // swim already under way
  const frames = await grab(clip, P, from, STEP);
  const S = [];
  for (const f of frames) { const r = await est(f.buf); S.push({ t: f.t, s: r.s, nose: r.kp && r.kp.nose, hip: r.kp && (r.kp.left_hip || r.kp.right_hip) }); }

  // settleT: first i such that the next WIN samples all have score>THR, nose present,
  // and nose-x span < FRAC*W  (swimmer parked on the wall)
  const runSettle = (THR, noseThr, FRAC, WIN) => {
    for (let i = 0; i + WIN <= S.length; i++) {
      const w = S.slice(i, i + WIN);
      if (w.every((x) => x.s > THR && x.nose && x.nose.score > noseThr)) {
        const xs = w.map((x) => x.nose.x);
        if (Math.max(...xs) - Math.min(...xs) < FRAC * W) return w[0].t;
      }
    }
    return null;
  };
  const variants = {
    "s.40/n.35/6%/1.6s": runSettle(0.40, 0.35, 0.06, Math.round(1.6 / STEP)),
    "s.45/n.40/6%/1.6s": runSettle(0.45, 0.40, 0.06, Math.round(1.6 / STEP)),
    "s.45/n.40/8%/2.0s": runSettle(0.45, 0.40, 0.08, Math.round(2.0 / STEP)),
    "s.50/n.45/5%/2.0s": runSettle(0.50, 0.45, 0.05, Math.round(2.0 / STEP)),
  };
  results.push({ name, gt: gt.touch, variants });
  let line = `\n=== ${name}  GT touch=${gt.touch}  (dur ${D.toFixed(1)}) ===\n`;
  for (const x of S) line += ` t=${x.t.toFixed(2)} s=${x.s.toFixed(2)} nose=${x.nose ? `(${x.nose.x.toFixed(0)},${x.nose.y.toFixed(0)})/${x.nose.score.toFixed(2)}` : "-"}\n`;
  console.log(line);
}

console.log("\n\n==== settleT vs GT touch ====");
console.log("clip        GT touch   " + Object.keys(results[0].variants).join("   "));
for (const r of results) {
  const cells = Object.values(r.variants).map((v) => v == null ? "  null " : `${v.toFixed(2)} (${r.gt == null ? "?" : (v - r.gt >= 0 ? "+" : "") + (v - r.gt).toFixed(2)})`);
  console.log(`${r.name}   ${r.gt == null ? "  -   " : String(r.gt).padStart(6)}     ${cells.join("   ")}`);
}
