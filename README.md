# Swim Timer

Frame-accurate timing for a two-length swim, taken off a phone video. Dive to touch.

Nothing is uploaded. The clip is read locally through an object URL and never leaves the device.

## Layout

Everything that matters is in `src/App.jsx`:

- lines 19-134 — `detect()`, the analysis pipeline, no React in it
- lines 174+ — the component
- lines 488+ — styles

The rest of the repo is Vite scaffolding. `tools_reference_pipeline.py` is the same
pipeline in Python, kept so the rules can be re-run against clips with known answers
without a browser.

## What the scan does

Plays the clip muted at 16x, sampling every presented frame into a 64px luma grid, and
measures frame-to-frame difference. Roughly 1.5s for a 23s clip.

From that it produces:

- **A camera-handling gate.** Frames where more than a quarter of the pixels change are
  the phone being set down or picked up. A person walking through frame moves a minority
  of pixels; a moving camera moves nearly all of them. An earlier version watched the top
  of the frame for sky movement and threw away an entire dive because the swimmer's back
  filled the sky.
- **A water region**, from per-cell temporal variance, so deck movement doesn't compete
  with the swim.
- **A motion trace** drawn over the timeline.
- **Four ranked candidate moments** — the loudest events in the water, spread at least
  1.2s apart, each walked back to the start of its rise. Tap one to jump there.

## What it does not do

Name which candidate is the dive and which is the touch.

Rules that tried were tested against four clips from three camera positions and none
generalised. With the phone close to the start the entry splash is the loudest event in
frame; moved back, it is one of the quietest and mid-pool swimming beats it. So any
"loudest peak near the start of the swim" rule picks the dive on one clip and the wrong
event on the next — measured errors ranged from -2.7s to +13.2s across the set. A touch
rule that landed within 13ms on one clip was 6s out on another. That was geometry, not a
working detector.

The turn is not detectable at all: at the far wall the swimmer is smaller than the
sparkle on the water.

So the scan narrows a 35-second clip to four places worth looking, and the call stays with
the person watching. Marks are placed by hand, frame by frame, at 0.1x with up to 3x zoom,
and snap to the frame the browser actually presented via `requestVideoFrameCallback`
rather than to `currentTime + 1/fps`.

## What would make it automatic

A camera position where both walls are in frame with the water line horizontal. Both
events then become "swimmer crosses a fixed line", which is a geometry problem rather than
a loudness problem, and can be solved for that one setup.

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

## License

MIT
