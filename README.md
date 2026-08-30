# Swim Timer

Frame-accurate timing for a two-length swim, taken off a phone video. Dive to touch.

Nothing is uploaded. The clip is read locally through an object URL and never leaves the device.

## Layout

- `src/detect.js` — `detect()`, the motion scan. Pure JS, no React, no DOM, so it
  runs both in the browser and in the offline scoring harness.
- `src/dive-pose.js` — `detectDive()`, the pose pass. Lazy-loads TensorFlow.js +
  MoveNet (weights vendored in `public/models/`) only on first use; nothing of it
  is in the main bundle.
- `src/detect-lines.js` — `detectLines()`, the line-crossing detector for a
  side-on reshoot. Opt-in from the UI; returns "unfound" on the current clips.
- `src/App.jsx` — the player, the scan, and the UI.

The rest is Vite scaffolding. A Python copy of the pipeline (`tools_reference_pipeline.py`)
drifted from the JS and was removed; the rules are re-checked against clips with known
answers through `tools/score.mjs` and `tools/pose/score-dive.mjs` (see below).

## How a clip is read

1. **Motion scan** (`detect()`) — plays the clip muted at 16x, samples every presented
   frame into a 64px luma grid, measures frame-to-frame difference (~2s for a 23s clip).
   Produces: a **camera-handling gate** (frames where >25% of pixels change are the phone
   being moved, not someone walking through); a **water region** from per-cell temporal
   variance; a **motion trace**; and **ranked candidate moments** — the loudest events in
   the water. It deliberately does not name any of them: from a corner camera the entry
   splash is the loudest thing in frame, from further back it is one of the quietest, so
   "loudest peak near the start" picked the dive on one test clip and the wrong second on
   the next (errors −2.7s to +13.2s across four clips).

2. **Pose pass** (`detectDive()`) — runs automatically after the scan. MoveNet finds the
   swimmer on the blocks — airborne and unoccluded, the one place a pose model works — and
   times the ankles leaving the deck. A localization sweep across the whole clip locates
   the start (the motion scan's swim window can't — it mislocalizes by 5–15s on the
   far-camera clips), then coarse + fine passes refine it. **Dive lands within ±2 frames on
   all four reference clips.** ~6–12s in the browser; falls back to the CPU backend
   (~10× slower) where WebGL is missing, and to a flagged motion-scan guess if the swimmer
   is never seen on the deck.

3. **Wall** — auto-placed on the best late motion candidate, always flagged as a guess
   with an honest ± (which widens to several tenths of a second on a clip where the finish
   can't be told from the swimmer climbing out). Confirm it by stepping to the frame.

4. **Turn** — not auto-placed. At the far wall the swimmer is smaller than the sparkle on
   the water; no method tried finds it. Mark it by hand if you want length splits.

Every mark shows how it was placed (pose / guess / hand / wall-crossing) and the ± the app
will stand behind. Marking by hand overrides and drops the ± to one frame. Frame stepping
snaps to the frame the browser actually presented via `requestVideoFrameCallback`, not
`currentTime + 1/fps`.

## A camera position that would make all three automatic

Phone on the **long side** of the pool, both end walls in frame, water line roughly
horizontal. Every event then becomes "swimmer crosses a fixed line" — geometry, not
loudness — and `src/detect-lines.js` reads it.

### `src/detect-lines.js` — the line-crossing detector for that reshoot

`detectLines(frames, opts)` is the detector for the good camera position, built and
tested now so a reshoot is plug-and-play. `frames` is a decoded grayscale stack (an
array, or a `{ count, width, height, fps, at(i) }` accessor — App.jsx does a second
`runScan` pass into a ~200px canvas and keeps the luma buffers). It builds a
temporal-median background over the camera-steady window, runs Sobel + a Hough vote on
that median, keeps straight edges that border high-temporal-variance water on one side
and static deck on the other, samples a motion-energy band along each, and reports
`{ dive, turn, touch, uncertainty, lines, notes, unfound, diagnostics }`.

It answers only when it can see the whole two-length structure: **two parallel,
well-separated wall lines**, and the swimmer **alternating** between them — a burst at the
near wall (dive), a quiet spell there while a burst crosses the far wall (turn), another
near-wall burst (touch). Anything less returns every field `null`, all three events in
`unfound`, and `diagnostics.reason` naming the problem. No hardcoded row, no draggable
line.

On the four current corner-shot clips it returns `unfound` on all four, each for a
specific geometric reason (no two parallel walls / walls not parallel / one edge found
twice / the loudest near-edge motion is someone stepping in or out at the clip boundary).
`tools/lines/SYNTHETIC.md` describes the camera setup that unlocks it and includes a
generated test clip (`make-synthetic.mjs` → `synthetic-test.mjs`) on which the same
detector recovers dive, turn and touch to within a few frames — the math works; the four
real clips fail on geometry.

```bash
node tools/lines/score-lines.mjs      # detectLines vs the 4 real clips (all unfound, with reasons)
node tools/lines/make-synthetic.mjs   # render tools/lines/synthetic-crossing.mp4
node tools/lines/synthetic-test.mjs   # prove the crossing math on cooperating geometry
```

## Accuracy

Bounded by frame rate. At 30 fps a frame is 33 ms, so a time is only ever good to about a
third of a tenth. Shoot slo-mo at 120 or 240 if the touch matters.

## Format note

iPhone records 10-bit HDR HEVC. Safari plays it; most other browsers do not, and the app
shows a decode message when that happens. In Photos, share the clip and pick **Most
Compatible**.

## Run it

```bash
npm install
npm run dev
```

`npm install` pulls TensorFlow.js (`@tensorflow/tfjs-*`, `@tensorflow-models/pose-detection`)
for the pose pass, and `@tensorflow/tfjs-node` as a dev dependency for the offline dive
scorer. `tfjs-node` builds a native addon — if that fails on your machine the app and
`npm test` still work; only `tools/pose/score-dive.mjs` needs it.

## Testing / scoring

An offline harness runs `detect()` against real clips with hand-marked dive and
touch times, so a change to the pipeline can be scored before it ships.

The test clips are not in the repo. Point `extract-fixtures` at local copies
(the `package.json` script has paths for the four reference clips) to build
fixtures under `test/fixtures/`:

```bash
npm run extract-fixtures     # ffmpeg-decodes each clip into the 64-wide luma
                             # grid the browser scan builds, writes <clip>.bin.gz
                             # (gzip of raw per-frame cell bytes) + <clip>.json
npm test                     # node:test — detect() runs clean on every fixture,
                             # candidate-count and dive-proximity sanity checks
node tools/score.mjs         # prints the baseline table: for each ground-truth
                             # event, the closest candidate and the error in
                             # frames (1 frame = 1/30 s), plus the swim window
```

Fixtures keep the full 64-wide grid so `detect()` sees exactly what the browser
would; gzip takes each one to ~1–2 MB.

`tools/score.mjs` also scores a real detector: `--detector <path>` to an ES
module whose default export is `(samples, fps) => ({ dive, turn, touch,
uncertainty, notes })`. That form is graded dive ±2 frames, touch ±3, turn ±5.

`tools/fixture-io.mjs` (`loadFixture(name)`) is the loader shared by the tests
and the scorer.

### Pose dive scorer

```bash
node tools/pose/score-dive.mjs      # needs the .mov clips in /Users/User/Downloads/files
```

Runs `detectDive()`'s exact logic (`_localizeDeck` + `_analyzeDive` from
`src/dive-pose.js`, the vendored MoveNet weights, the same square-letterbox
padding) over ffmpeg-decoded frames instead of `<video>` seeks, and prints the
per-clip dive error in frames against the ground-truth bracket. Current: 7199 +2,
7464 0, 7465 0, 7466 −1 → within ±2 on all four.

### `src/detect-lines.js`

```bash
node tools/lines/score-lines.mjs    # vs the 4 real clips — all "unfound", with reasons
node tools/lines/synthetic-test.mjs # proves the crossing math on cooperating geometry
```

## License

MIT
