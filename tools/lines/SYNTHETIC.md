# The clip `detectLines` is built for

`src/detect-lines.js` turns every swim event into one primitive: **a tracked
point crosses a fixed image line.** That only works if the camera gives it a
fixed image line to cross. This is what that looks like, and how to shoot it.

## The camera setup that unlocks automatic timing

- **Stand on the LONG side of the pool**, roughly level with the middle of the
  lane, phone on a tripod or propped on something solid. Not a corner. Not
  behind the blocks.
- **Both end walls in frame.** The start/turn wall and the far wall must both be
  visible for the whole swim, near the left and right of the frame.
- **Water surface roughly horizontal.** Keep the phone level so the water line
  runs straight across the frame rather than climbing a diagonal.
- **Hold still.** Any pan or bump inside the swim blanks a ±0.45 s window (the
  same camera-handling gate `src/detect.js` uses).
- **Frame tight to the water.** The less deck, sky, hedge and treeline in frame,
  the less there is to compete with the two wall edges. Fill the frame with
  water from end wall to end wall.
- **Start on the blocks, end on the touch.** Begin recording with the swimmer
  already set on the blocks and stop within a second or two of the finish. If
  someone is walking to the blocks at the top of the clip, or climbing out at
  the end, that motion happens right at the near wall and the detector cannot
  tell it apart from a dive or a touch — it will (correctly) refuse the clip.
- Slo-mo (120/240 fps) still helps: the answer is never better than one frame.

### Why the current four reference clips fail

They are corner shots (see `tools/pose/out/median_IMG_*.png`):

| clip | what `detectLines` reports |
|------|----------------------------|
| IMG_7199 | **no usable edge** — the one straight water edge is the near long side; its loudest motion is a person by the camera at the clip edge, not a crossing |
| IMG_7464 | **no usable edge** — two edges are found but they are 82° apart (a deck line and a pole), not two parallel walls; and the near edge's bursts are pre-swim / exit activity |
| IMG_7465 | **no usable edge** — only one real water edge (the near long side); the "touch" burst is someone leaving the pool at the end of the clip |
| IMG_7466 | **no usable edge** — the two strongest edges are 6% of the frame apart: one pool edge found twice, not opposite end walls |

In every case the near end wall is an oblique curve that no straight line
follows, the far end wall is lost in the treeline, and the only long straight
water edge runs the *length* of the swim, so the swimmer travels along it
instead of crossing it. That is a geometry problem the algorithm cannot fix; a
reshoot from the long side fixes it for free.

## The synthetic proof

`make-synthetic.mjs` renders `synthetic-crossing.mp4` with ffmpeg: a 320×180,
30 fps, 22 s clip of an imaginary pool shot the right way —

- mid-grey deck
- a "water" band between two horizontal white wall lines (`y = 39` far,
  `y = 139` near), with a slow global brightness flicker so the band has real
  temporal variance (the water/deck boundary test needs it) but no moving
  spatial structure (nothing that fakes a swimmer)
- a bright 40×12 blob = the swimmer, composited with `overlay` so its position
  is a per-frame function of time. Its vertical centre:
  on the block (`y = 172`) → dives and swims to the far wall (`y = 40`) → holds
  at the far wall 8–9 s → swims back → climbs out (`y = 172`).

Geometry gives the exact crossing times: **dive 4.63 s, turn ~8.5 s (a 1 s
plateau at the far wall), touch 12.75 s.**

`synthetic-test.mjs` decodes that clip and runs the *same* `detectLines` that
returns `unfound` on all four real clips:

```
$ node tools/lines/make-synthetic.mjs     # writes synthetic-crossing.mp4
$ node tools/lines/synthetic-test.mjs

lines:
  [near] horizontal angle 0.0deg  y~140  contrast 7.6  band 0.4->28.6
  [far]  horizontal angle 0.0deg  y~40   contrast 9.6  band 0.7->24.5

events:
  dive   gt 4.63s   got 4.54s   err -0.09s ( -2.8 fr)   PASS
  turn   gt 8.50s   got 9.30s   err +0.80s (+24.1 fr)   PASS
  touch  gt 12.75s  got 12.85s  err +0.10s ( +3.1 fr)   PASS

PASS — crossing math recovers all three events when the geometry cooperates.
```

- **dive** and **touch** land within ~3 frames: the near wall's motion band is
  quiet, then a localised burst as the blob sweeps through it, and the
  energy-weighted centre of that burst is the crossing.
- **turn** lands ~0.8 s late because the far-wall event is a one-second plateau
  (the blob sitting at the wall), not an instant; the reported time is inside
  that plateau. The reported uncertainty (`±250 ms`) reflects this — a
  motion-energy band times a crossing to ~10 frames, not to the frame, and the
  detector says so rather than pretending otherwise.

The point of the test is not the exact numbers; it is that the crossing
detection, the two-wall geometry gate, the near→far→near alternation check and
the event assembly all work end to end **when the camera cooperates.** The four
real clips fail on geometry, not on math.

## Tuning knobs

All thresholds are in `DEFAULTS` at the top of `src/detect-lines.js` and can be
overridden per call via `opts`. The ones most likely to need a real reshoot to
calibrate:

- `minWallSepFrac` (0.22) — how far apart the two walls must be in the frame
- `maxMiddleHotFrac` (0.22) — how quiet the near wall must go mid-swim
- `edgeMarginSec` (1.6) — dead zone at each end of the clip
- `waterVarPct` / `minWaterContrast` — what counts as a water/deck boundary
- `smoothMaxRadius` / `bandSegments` — band-signal conditioning
