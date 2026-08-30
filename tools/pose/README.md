# tools/pose — automatic dive detection (R&D + production module)

## What shipped

`src/dive-pose.js` — a browser ES module that finds the **dive** in a phone-video
swim clip by running MoveNet on the on-deck racing start and timing the frame the
ankles leave the blocks.

- `detectDive({ video, fps, searchFrom, searchTo, onProgress, modelUrl })`
  → `{ t, uncertaintyFrames, confidence, method: 'pose-ankle-off-deck' }` or `null`
- `detectTouchTurn(...)` → attempted, returns `{ turn: {t:null,…}, touch: {t:null,…} }`
  with reasons. Turn and touch are **not** recoverable from these camera angles
  (swimmer submerged / a speck at the far wall / buried in their own splash at the
  touch). See "Honest verdict" below.

TFJS + the model are pulled in with dynamic `import()` on first use, so nothing
lands in the main app bundle until the feature runs.

## Model weights — source and version

Vendored into `public/models/movenet/` so `npm run build` produces a
self-contained app and the fetch works offline / in a sandbox (never tfhub at
runtime).

| | |
|---|---|
| Model | MoveNet **SinglePose Lightning** |
| Version | **4** (TF-Hub `google/tfjs-model/movenet/singlepose/lightning/4`) |
| Format | TFJS graph model, float16 weights |
| Source URL | `https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4/model.json?tfjs-format=file` (+ the two `group1-shard*.bin` from the same base) |
| Files | `model.json` (164 KB) + `group1-shard1of2.bin` (4.00 MB) + `group1-shard2of2.bin` (445 KB) |
| Total | **4.8 MB** |
| License | Apache-2.0 (Google) |

To re-fetch:

```sh
B="https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4"
mkdir -p public/models/movenet && cd public/models/movenet
for f in model.json group1-shard1of2.bin group1-shard2of2.bin; do
  curl -sL "$B/$f?tfjs-format=file" -o "$f"
done
```

The int8 build (~3 MB) is only distributed inside the `@tensorflow-models` npm
tarball's test assets and isn't separately downloadable; float16 at 4.8 MB is the
standard hosted artifact and is under the 5 MB budget.

## Scoring — `node tools/pose/score-dive.mjs`

Runs the **same** `_analyzeDive()` (imported from `src/dive-pose.js`), the same
square-letterbox padding, and the same vendored weights; only the runtime differs
(tfjs-node + an ffmpeg pipe instead of tfjs-webgl + `<video>` seeks).

Latest run (this machine, MoveNet Lightning, ~30 fps clips):

```
  clip        fps      GT dive   detected   err(frames)  conf
  IMG_7199   29.99      1.05s    1.102s       +2         0.39
  IMG_7464   29.99     12.75s   12.703s       -1         0.42
  IMG_7465   29.99     2.234s    2.235s        0         0.40
  IMG_7466   29.99      12.5s   12.438s       -2         0.53
  worst |error| = 2 frames  ->  PASS (bar: dive ±2)
  inference: mean ~12 ms/frame, median ~11 ms, p90 ~14 ms
```

IMG_7199's ground truth is itself approximate ("~1.05 s" in the brief).

## Honest verdict — turn & touch

Measured on all four clips: MoveNet returns **1 usable frame in ~240** through
the turn (the far wall is <10 px of swimmer against a moving treeline), and pose
score at the true touch frame is ~0.27 (noise) because the swimmer is inside
their own splash. Pose only re-acquires a stable swimmer **~1.5 s (~45 frames at
30 fps) after the touch**, once they are parked on the wall
(IMG_7466: settle 27.2 s vs touch 25.5 s; IMG_7464 similar). That is far outside
a ±10-frame bar, so `detectTouchTurn` returns `t: null` with a reason and hands
back the settle time only as a diagnostic. Turn/touch stay with the ranked
motion-energy candidates from `detect()` and the human.

The classical-CV fallback (`fallback.py`, `bands.py`) was also tried: dive/touch
motion peaks land within a few frames of ground truth **only** in a
per-camera-position hand-picked water ROI; there is no camera-agnostic rule that
separates the dive splash from on-deck prep and end-of-clip climb-out, and no
band shows any turn signal. Same geometric wall the existing `detect.js` hits.

## Files

| file | what |
|---|---|
| `movenet.mjs` | per-frame MoveNet extraction + benchmark (`PAD=1`, `CROP=`, `POSE_MODEL=`) |
| `analyze.mjs` | R&D: trajectory build + dive read from a pose CSV |
| `score-dive.mjs` | **production scorer** — exercises `src/dive-pose.js`'s `_analyzeDive` |
| `fallback.py` | classical CV: median frame → waterline fit → band motion energy |
| `bands.py` | diagnostic: per-water-cell motion energy vs. time around each event |
| `out/` | trajectory CSVs, temporal-median frames, detected-dive frames |

`frames/` (extracted PNGs) and `out/*.pgm` are git-ignored; regenerate with the
ffmpeg line in `movenet.mjs`'s header.

## Camera setup that would make turn & touch automatic

Phone propped ~1.5 m high and ~3–5 m back on the **long** side of the pool (not
the corner), both walls in frame, water line roughly horizontal across the frame.
The swimmer then stays 30–60 px the whole length, is never occluded by their own
splash, and MoveNet's inter-frame crop tracking stays locked — dive, turn and
touch all become "a keypoint crosses a fixed image line".
