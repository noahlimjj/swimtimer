/* ---------------------------------------------------------------------------
   fixture-io.mjs — read the fixtures written by tools/extract-fixture.mjs.

   loadFixture(name)  -> { name, samples, fps, duration, frameCount, w, h }
     samples[i] = { t, frac, cells }
     samples[i].cells is a Uint8Array VIEW into one decoded buffer (no copy),
     directly usable by detect(samples, fps) from ../src/detect.js.

   listFixtures()     -> string[] of fixture names present in test/fixtures/
   --------------------------------------------------------------------------- */

import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIX_DIR = join(HERE, "..", "test", "fixtures");

export function listFixtures() {
  if (!existsSync(FIX_DIR)) return [];
  return readdirSync(FIX_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadFixture(name) {
  const meta = JSON.parse(readFileSync(join(FIX_DIR, `${name}.json`), "utf8"));
  const buf = gunzipSync(readFileSync(join(FIX_DIR, `${name}.bin.gz`)));
  const N = meta.cellCount;
  const nSamples = meta.t.length;
  if (buf.length !== nSamples * N) {
    throw new Error(
      `${name}: cell buffer is ${buf.length} bytes, expected ${nSamples * N}`
    );
  }
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const samples = new Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    samples[i] = {
      t: meta.t[i],
      frac: meta.frac[i],
      cells: bytes.subarray(i * N, i * N + N),
    };
  }
  return {
    name: meta.name,
    samples,
    fps: meta.fps,
    duration: meta.duration,
    frameCount: meta.frameCount,
    w: meta.w,
    h: meta.h,
  };
}
