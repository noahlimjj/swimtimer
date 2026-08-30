/* MoveNet SinglePose per-frame pose extraction + benchmark.
   Usage: node tools/pose/movenet.mjs <clip>  [stride] [startFrame] [endFrame]
   Writes tools/pose/out/<clip>.pose.csv  with one row per processed frame:
   frame,ms,score, then x,y,score for each of 17 keypoints.
   Also prints a timing benchmark line to stderr. */
import * as tf from '@tensorflow/tfjs-node';
import * as poseDetection from '@tensorflow-models/pose-detection';
import fs from 'node:fs';
import path from 'node:path';

const clip = process.argv[2];
const stride = parseInt(process.argv[3] || '1', 10);
const startF = parseInt(process.argv[4] || '1', 10);
const endF = process.argv[5] ? parseInt(process.argv[5], 10) : Infinity;
const model = process.env.POSE_MODEL || 'lightning'; // lightning | thunder | blazepose
// CROP="x0,y0,x1,y1" in fractions of the 480x854 frame. Cropped region is
// resized to a square before inference; keypoints are mapped back to full-frame px.
const CROP = process.env.CROP ? process.env.CROP.split(',').map(Number) : null;
const PAD = process.env.PAD === '1'; // pad portrait frame to a square (no aspect squish)

const dir = path.join('tools/pose/frames', clip);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const KP = poseDetection.util
  ? null : null;

let detector;
if (model === 'blazepose') {
  detector = await poseDetection.createDetector(poseDetection.SupportedModels.BlazePose, {
    runtime: 'tfjs', modelType: 'full', enableSmoothing: false,
  });
} else {
  detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: model === 'thunder'
      ? poseDetection.movenet.modelType.SINGLEPOSE_THUNDER
      : poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
  });
}

const outRows = [];
const times = [];
// warm up
{
  const buf = fs.readFileSync(path.join(dir, files[0]));
  const img = tf.node.decodePng(buf, 3);
  await detector.estimatePoses(img);
  img.dispose();
}

const FW = 480, FH = 854;
for (let i = startF - 1; i < files.length && i < endF; i += stride) {
  const buf = fs.readFileSync(path.join(dir, files[i]));
  let img = tf.node.decodePng(buf, 3);
  let ox = 0, oy = 0, sx = 1, sy = 1;
  if (PAD) {
    const padded = tf.tidy(() => img.pad([[0, 0], [Math.floor((FH - FW) / 2), Math.ceil((FH - FW) / 2)], [0, 0]]));
    img.dispose();
    img = padded;
  }
  if (CROP) {
    const [x0, y0, x1, y1] = CROP;
    const px0 = Math.round(x0 * FW), py0 = Math.round(y0 * FH);
    const cw = Math.round((x1 - x0) * FW), ch = Math.round((y1 - y0) * FH);
    const side = Math.max(cw, ch);
    const cropped = tf.tidy(() => {
      const sl = img.slice([py0, px0, 0], [ch, cw, 3]);
      return tf.image.resizeBilinear(sl.expandDims(0), [side, side]).squeeze([0]);
    });
    img.dispose();
    img = cropped;
    ox = px0; oy = py0; sx = cw / side; sy = ch / side;
  }
  const t0 = process.hrtime.bigint();
  const poses = await detector.estimatePoses(img, { maxPoses: 1 });
  const t1 = process.hrtime.bigint();
  img.dispose();
  if (CROP) for (const p of poses) for (const k of p.keypoints) { k.x = ox + k.x * sx; k.y = oy + k.y * sy; }
  if (PAD) for (const p of poses) for (const k of p.keypoints) { k.x -= (FH - FW) / 2; }
  const ms = Number(t1 - t0) / 1e6;
  times.push(ms);
  const frame = i + 1;
  if (!poses.length) {
    outRows.push([frame, ms.toFixed(1), 0].join(','));
    continue;
  }
  const p = poses[0];
  const kps = p.keypoints;
  const row = [frame, ms.toFixed(1), (p.score ?? 0).toFixed(3)];
  for (const k of kps) row.push(k.x.toFixed(1), k.y.toFixed(1), (k.score ?? 0).toFixed(3));
  outRows.push(row.join(','));
}

const names = model === 'blazepose'
  ? poseDetection.util.getKeypointIndexBySide(poseDetection.SupportedModels.BlazePose)
  : null;
const header = ['frame', 'ms', 'score'];
const kpNames = (model === 'blazepose')
  ? ['nose','left_eye_inner','left_eye','left_eye_outer','right_eye_inner','right_eye','right_eye_outer','left_ear','right_ear','mouth_left','mouth_right','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_pinky','right_pinky','left_index','right_index','left_thumb','right_thumb','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle','left_heel','right_heel','left_foot_index','right_foot_index']
  : ['nose','left_eye','right_eye','left_ear','right_ear','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle'];
for (const n of kpNames) header.push(n + '_x', n + '_y', n + '_s');

fs.mkdirSync('tools/pose/out', { recursive: true });
const suffix = stride === 1 && startF === 1 && endF === Infinity ? '' : `.s${stride}_${startF}-${isFinite(endF)?endF:'end'}`;
const outPath = `tools/pose/out/${clip}.${model}${suffix}.pose.csv`;
fs.writeFileSync(outPath, header.join(',') + '\n' + outRows.join('\n') + '\n');

const sorted = times.slice().sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / times.length;
const med = sorted[Math.floor(sorted.length / 2)];
process.stderr.write(
  `[${model}] ${clip}: ${times.length} frames, mean ${mean.toFixed(1)} ms, ` +
  `median ${med.toFixed(1)} ms, p90 ${sorted[Math.floor(sorted.length*0.9)].toFixed(1)} ms -> ${outPath}\n`);
