/* ---------------------------------------------------------------------------
   decode.mjs — ffmpeg-decode a clip into a grayscale frame stack for
   detectLines().  Node-only (spawns ffmpeg); the fixtures' 64px grid is far
   too coarse to fit lines to, so this decodes its own frames at ~240px wide.

   decodeGray(path, { width = 240 }) -> accessor object:
     { count, width, height, fps, at(i) -> Uint8Array(w*h), t(i) -> seconds }
   --------------------------------------------------------------------------- */

import { spawnSync } from 'node:child_process';

function probe(path) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-print_format', 'json',
     '-show_streams', '-show_format', path],
    { encoding: 'utf8', maxBuffer: 1 << 24 }
  );
  if (r.status !== 0) throw new Error(`ffprobe failed for ${path}: ${r.stderr}`);
  const d = JSON.parse(r.stdout);
  const s = d.streams[0];
  let rot = 0;
  for (const sd of s.side_data_list || []) if (sd.rotation != null) rot = sd.rotation;
  let w = +s.width, h = +s.height;
  if (Math.abs(rot) === 90) [w, h] = [h, w]; // ffmpeg autorotates on decode
  return { w, h, duration: +d.format.duration };
}

export function decodeGray(path, { width = 240 } = {}) {
  const meta = probe(path);
  const W = width;
  const H = Math.max(24, Math.round(W * (meta.h / meta.w)));
  const N = W * H;
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path,
     '-vf', `scale=${W}:${H},format=gray`,
     '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 30 }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${path}: ${r.stderr}`);
  const buf = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length);
  const count = Math.floor(buf.length / N);
  if (count < 2) throw new Error(`${path}: decoded only ${count} frames`);
  const fps = count / meta.duration;
  return {
    count,
    width: W,
    height: H,
    fps,
    duration: meta.duration,
    at: (i) => buf.subarray(i * N, i * N + N),
    t: (i) => i / fps,
  };
}
