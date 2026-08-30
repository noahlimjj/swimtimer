/* Dump dense pose trajectories for offline _analyzeDive iteration.
   Writes tools/pose/out/traj_<clip>.json = { fps, H, loc:[...], dense:[...] }
   loc   = every ~1.3s over the whole clip
   dense = every frame over [gtDive-3.2, gtDive+3.0]
   node tools/pose/_dump_traj.mjs */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import * as tf from "@tensorflow/tfjs-node";
import * as pd from "@tensorflow-models/pose-detection";
import { squareLetterbox, mapKeypoints } from "../../src/dive-pose.js";

const W = 480, H = 854;
const MODEL = "file://" + path.resolve("/Users/User/swim_timer/public/models/movenet/model.json");
const GT = { IMG_7199: 1.05, IMG_7464: 12.75, IMG_7465: 2.234, IMG_7466: 12.5 };

const pts = (c) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
  "frame=best_effort_timestamp_time", "-of", "csv=p=0", c], { encoding: "utf8", maxBuffer: 1 << 26 })
  .stdout.trim().split("\n").map(parseFloat).filter(Number.isFinite);
const dur = (c) => parseFloat(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=duration", "-of", "csv=p=0", c], { encoding: "utf8" }).stdout);

function grab(clip, P, ranges) {
  // ranges: [{from,to,step}]  step 0 = every frame
  return new Promise((res, rej) => {
    const fb = W * H * 3;
    const ff = spawn("ffmpeg", ["-v", "error", "-i", clip, "-vf", `scale=${W}:${H},format=rgb24`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    let acc = Buffer.alloc(0), idx = 0;
    const next = ranges.map((r) => r.from);
    const out = ranges.map(() => []);
    ff.stdout.on("data", (c) => {
      acc = acc.length ? Buffer.concat([acc, c]) : c;
      while (acc.length >= fb) {
        const fr = acc.subarray(0, fb); acc = acc.subarray(fb);
        const t = P[idx] ?? idx / 30; idx++;
        ranges.forEach((r, k) => {
          if (t < r.from || t > r.to) return;
          if (r.step > 0) { if (t + 1e-9 < next[k]) return; next[k] += r.step; }
          out[k].push({ t, buf: Buffer.from(fr) });
        });
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
  if (!p.length) return { score: 0, kp: null };
  return { score: p[0].score ?? 0, kp: mapKeypoints(p[0].keypoints, offX, offY) };
}

for (const [name, gt] of Object.entries(GT)) {
  const clip = `/Users/User/Downloads/files/${name}.mov`;
  const P = pts(clip), D = dur(clip);
  const fps = (P.length - 1) / (P[P.length - 1] - P[0]);
  const [locF, denseF] = await grab(clip, P, [
    { from: 0, to: D, step: 1.3 },
    { from: Math.max(0, gt - 3.2), to: Math.min(D, gt + 3.0), step: 0 },
  ]);
  const conv = async (frames) => {
    const o = [];
    for (const f of frames) { const r = await est(f.buf); o.push({ t: f.t, score: r.score, kp: r.kp }); }
    return o;
  };
  const rec = { name, fps, H, dur: D, gtDive: gt, loc: await conv(locF), dense: await conv(denseF) };
  fs.writeFileSync(`tools/pose/out/traj_${name}.json`, JSON.stringify(rec));
  console.log(`${name}: fps=${fps.toFixed(3)} loc=${rec.loc.length} dense=${rec.dense.length}`);
}
