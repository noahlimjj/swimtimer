# Swim Timer

Frame-accurate timing for a two-length swim, taken straight off a phone video. Dive to touch.

Nothing is uploaded. The clip is read locally through an object URL and never leaves the device.

## What it does

- **Scan the clip** — plays the video fast and muted, sampling every presented frame into a 48px
  canvas and measuring frame-to-frame difference. The result is drawn as a motion trace above the
  timeline, so the dive and the wall arrival are visible as spikes before you look at a single frame.
- **Automatic dive placement** — takes the loudest frame of the first burst of movement. On the test
  clip this landed within two frames of the real takeoff. It is a starting point, not a verdict.
- **Manual marks** — dive, turn (optional), touch. Frame stepping at 0.1× playback, with marks
  snapped to the frame the browser actually presented via `requestVideoFrameCallback` rather than to
  an arithmetic guess at `currentTime + 1/fps`.
- **Zoom and pan** up to 3× to call a touch that sits small in frame.
- **Splits and pace** — both lengths and a per-100 rate.
- **A saved log** with the fastest swim flagged.

## What it does not do

Detect the touch automatically. On a real clip the wall arrival is a broad splash lasting half a
second, often with other swimmers in frame, and the difference between the peak of that splash and
the hand hitting the wall is worth more than a tenth. The scan shows you where to look; you make
the call.

The turn is not detectable either — at the far end the swimmer is small and the signal is buried
under surface sparkle.

## Accuracy

Bounded by the clip's frame rate. At 30 fps a frame is 33 ms, so a time is only ever good to about
a third of a tenth. Shoot slo-mo at 120 or 240 fps if the touch matters.

## Filming

Side-on to the pool, with both the start and the wall in frame. Filming down the lane from behind
the block puts the swimmer's own splash between the camera and the touch.

## Format note

iPhone records HEVC, and 10-bit HDR HEVC at that. Safari plays it; most other browsers do not, and
the app shows a decode message when that happens. In Photos, share the clip and pick **Most
Compatible**, or turn off High Efficiency in Camera settings.

## Run it

```bash
npm install
npm run dev
```

Built with Vite and React, no other runtime dependencies.

## License

MIT
