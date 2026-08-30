#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   make-synthetic.mjs — generate tools/lines/synthetic-crossing.mp4:

   a long-side view of an imaginary pool, done right.  320x180, 30 fps, 22 s.

     - mid-grey deck
     - a "water" band between y=39 and y=139 with a global brightness flicker
       (high temporal variance, so the water/deck boundary test fires; no
       moving spatial structure, so it neither fakes a swimmer nor spawns
       spurious lines)
     - two white horizontal lines at the water/deck boundaries:
         FAR  wall at y = 39   (water below it)
         NEAR wall at y = 139  (water above it)
     - a bright 40x28 blob = the swimmer.  Its VERTICAL CENTRE moves as:
         t < 3.5s          on the block   (centre y = 172, clear of the near wall)
         3.5 .. 8.0s       dive + lap 1   (172 -> 40)   crosses NEAR at ~4.63s
         8.0 .. 9.0s       at the far wall (y = 40)      => turn 8.0-9.0s
         9.0 .. 14.0s      lap 2          (40 -> 172)    crosses NEAR at ~12.75s
         t > 14s           climbed out    (centre y = 172)

   GROUND TRUTH (geometry, exact): dive 4.63s, turn ~8.5s, touch 12.75s.

   The blob is composited with `overlay` (which supports a per-frame time
   expression); `drawbox` does not evaluate time, so it is only used for the
   two static wall lines.
   --------------------------------------------------------------------------- */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SYNTH_PATH = join(HERE, 'synthetic-crossing.mp4');

export const GROUND_TRUTH = { dive: 4.63, turn: 8.5, touch: 12.75, duration: 22 };

// piecewise-linear blob-CENTRE y(t); overlay y is top-left, so subtract half height (6)
const CY =
  "if(lt(t,3.5),172," +
  "if(lt(t,8),172-29.333*(t-3.5)," +
  "if(lt(t,9),40," +
  "if(lt(t,14),40+26.4*(t-9),172))))";
const Y_EXPR = `(${CY})-6`;

export function makeSynthetic(outPath = SYNTH_PATH) {
  const fc = [
    "[1:v]geq=lum='128+26*sin(T*0.35)':cb=128:cr=128[water]",
    "[0:v][water]overlay=x=0:y=39[bg]",
    "[bg]drawbox=x=0:y=39:w=320:h=2:color=white:t=fill," +
      "drawbox=x=0:y=138:w=320:h=2:color=white:t=fill[scene]",
    `[scene][2:v]overlay=x=140:y='${Y_EXPR}':eval=frame,format=yuv420p[out]`,
  ].join(';');

  const args = [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x180:r=30:d=22',
    '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x100:r=30:d=22',
    '-f', 'lavfi', '-i', 'color=c=white:s=40x12:r=30:d=22',
    '-filter_complex', fc,
    '-map', '[out]', '-r', '30', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-crf', '10',
    outPath,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr}`);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = makeSynthetic();
  console.log(`wrote ${p}`);
  console.log(`ground truth: dive ${GROUND_TRUTH.dive}s  turn ~${GROUND_TRUTH.turn}s  touch ${GROUND_TRUTH.touch}s`);
}
