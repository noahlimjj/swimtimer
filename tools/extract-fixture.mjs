#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   extract-fixture.mjs <clip.mov> [<clip.mov> ...]

   Decodes each clip through ffmpeg into the SAME 64-wide luma grid the browser
   scan builds (see `runScan` in src/App.jsx), turns it into the `samples` array
   `detect()` consumes, and writes a fixture pair under test/fixtures/:

     <base>.bin.gz  — gzip of the raw concatenated per-frame cell bytes
                      (Uint8, N = 64*H bytes per sample, samples in order)
     <base>.json    — metadata sidecar: { name, w, h, cellCount, frameCount,
                      duration, fps, t: number[], frac: number[] }

   Why .bin.gz + sidecar: the raw grid for a 37 s clip is ~8 MB; the cell values
   are small abs-luma differences and gzip crushes them to ~1 MB. Keeping the
   full 64-wide grid means the fixture feeds detect() exactly what the browser
   would, with no resampling.

   Frame model, matching tools_reference_pipeline.py and the browser:
     - decoded frame count = n; samples.length = n - 1 (first frame has no prev)
     - fps = (n - 1) / duration
     - sample k (0-based) is |frame[k+1] - frame[k]| and gets t = (k + 1) / fps
   --------------------------------------------------------------------------- */

import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_W = 64;
const DIFF_THRESH = 12; // abs luma diff that counts a cell as "changed"

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "..", "test", "fixtures");

function probe(path) {
  const q = [
    "-v", "error", "-select_streams", "v:0",
    "-print_format", "json", "-show_streams", "-show_format", path,
  ];
  const r = spawnSync("ffprobe", q, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ffprobe failed for ${path}: ${r.stderr}`);
  const d = JSON.parse(r.stdout);
  const s = d.streams[0];
  let rot = 0;
  for (const sd of s.side_data_list || []) {
    if (sd.rotation != null) rot = sd.rotation;
  }
  let w = +s.width;
  let h = +s.height;
  if (Math.abs(rot) === 90) [w, h] = [h, w]; // ffmpeg autorotates on decode
  return { w, h, duration: +d.format.duration, rot };
}

function decode(path, H) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-i", path,
      "-vf", `scale=${SCAN_W}:${H},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { maxBuffer: 1 << 30 }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${path}: ${r.stderr}`);
  return r.stdout; // Buffer of gray bytes
}

function buildFixture(path) {
  const meta = probe(path);
  const H = Math.max(24, Math.round(SCAN_W * (meta.h / meta.w)));
  const N = SCAN_W * H;
  const raw = decode(path, H);
  const n = Math.floor(raw.length / N);
  if (n < 2) throw new Error(`${path}: decoded only ${n} frames`);

  const fps = (n - 1) / meta.duration;
  const nSamples = n - 1;

  const cells = Buffer.allocUnsafe(nSamples * N); // raw concatenated Uint8
  const t = new Array(nSamples);
  const frac = new Array(nSamples);

  for (let k = 0; k < nSamples; k++) {
    const prevOff = k * N;
    const curOff = (k + 1) * N;
    const outOff = k * N;
    let changed = 0;
    for (let j = 0; j < N; j++) {
      let d = raw[curOff + j] - raw[prevOff + j];
      if (d < 0) d = -d;
      cells[outOff + j] = d; // 0..255, fits a byte
      if (d > DIFF_THRESH) changed++;
    }
    frac[k] = changed / N;
    t[k] = (k + 1) / fps;
  }

  const base = basename(path, extname(path));
  mkdirSync(FIX_DIR, { recursive: true });
  const gz = gzipSync(cells, { level: 9 });
  writeFileSync(join(FIX_DIR, `${base}.bin.gz`), gz);
  writeFileSync(
    join(FIX_DIR, `${base}.json`),
    JSON.stringify(
      {
        name: base,
        source: basename(path),
        w: SCAN_W,
        h: H,
        cellCount: N,
        frameCount: n,
        duration: meta.duration,
        fps,
        rotation: meta.rot,
        t,
        frac,
      },
      null,
      0
    )
  );

  return { base, H, n, nSamples, fps, rawMB: raw.length / 1e6, gzMB: gz.length / 1e6 };
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node tools/extract-fixture.mjs <clip.mov> [<clip.mov> ...]");
  process.exit(1);
}

for (const p of args) {
  const r = buildFixture(p);
  console.log(
    `${r.base}: ${r.n} frames -> ${r.nSamples} samples, grid ${SCAN_W}x${r.H}, ` +
      `fps ${r.fps.toFixed(3)}, raw ${r.rawMB.toFixed(1)} MB -> gz ${r.gzMB.toFixed(2)} MB`
  );
}
