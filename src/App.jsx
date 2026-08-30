import React, { useState, useRef, useEffect, useCallback } from "react";
import { detect } from "./detect.js";

/* The analysis pipeline lives in ./detect.js — pure JS, no React, so it can be
   scored against fixtures offline (tools/score.mjs). Everything below is the
   player, the scan that feeds detect(), and the UI. */

const SCAN_W = 64;        // analysis grid width
const SCAN_RATE = 16;     // playback multiplier during the scan

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const SPEEDS = [1, 0.5, 0.25, 0.1];
const ZOOMS = [1, 2, 3];

/* Provenance of each mark. source: null (unset) | 'pose' | 'guess' | 'hand';
   unc = ± frames the app will stand behind. Rebuilt fresh on every clip / scan. */
const EMPTY_AUTO = {
  dive: { source: null, unc: null },
  turn: { source: null, unc: null },
  touch: { source: null, unc: null },
};
const COURSES = [
  { id: "50m", label: "50 m", metres: 50 },
  { id: "100m", label: "100 m", metres: 100 },
  { id: "50y", label: "50 y", metres: 45.72 },
  { id: "100y", label: "100 y", metres: 91.44 },
];

const store = {
  async get(k) {
    try {
      if (window.storage) {
        const r = await window.storage.get(k);
        return r ? r.value : null;
      }
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  async set(k, v) {
    try {
      if (window.storage) return void (await window.storage.set(k, v));
      window.localStorage.setItem(k, v);
    } catch {
      /* session only */
    }
  },
};

function clockText(t) {
  if (t == null || !isFinite(t) || t < 0) return "--.--";
  const m = Math.floor(t / 60);
  const ss = (t - m * 60).toFixed(2).padStart(5, "0");
  return m > 0 ? `${m}:${ss}` : ss;
}

export default function App() {
  const videoRef = useRef(null);
  const railRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const urlRef = useRef(null);
  const panRef = useRef({ dragging: false, moved: false, x: 0, y: 0 });
  const effFpsRef = useRef(30); // frame rate the last scan measured, for the on-demand pose pass

  const [src, setSrc] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [decodeError, setDecodeError] = useState(false);
  const [portrait, setPortrait] = useState(false);

  const [fps, setFps] = useState(30);
  const [speed, setSpeed] = useState(0.25);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const [dive, setDive] = useState(null);
  const [turn, setTurn] = useState(null);
  const [touch, setTouch] = useState(null);

  const [result, setResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanPct, setScanPct] = useState(0);
  const [scanMs, setScanMs] = useState(null);
  const [scanRate, setScanRate] = useState(SCAN_RATE); // dropped to 8x on a device that can't keep up
  const [droppedFrames, setDroppedFrames] = useState(false);
  const [note, setNote] = useState(null);

  /* How each mark got its value — see EMPTY_AUTO. source: null | 'pose' | 'guess' | 'hand',
     unc is the ± in frames the app will stand behind for that mark. */
  const [auto, setAuto] = useState(EMPTY_AUTO);
  const [posePct, setPosePct] = useState(null); // null = not running, 0..1 = finding the dive
  const [linesPct, setLinesPct] = useState(null); // null = not running, 0..1 = wall-crossing pass

  const [course, setCourse] = useState("50m");
  const [swims, setSwims] = useState([]);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    let alive = true;
    store.get("swims:log").then((v) => {
      if (!alive || !v) return;
      try {
        setSwims(JSON.parse(v));
      } catch {
        /* start fresh */
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback((next) => {
    setSwims(next);
    store.set("swims:log", JSON.stringify(next));
  }, []);

  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v) setCurrent(v.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    if (playing) rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && !scanning) v.playbackRate = speed;
  }, [speed, src, scanning]);

  useEffect(() => () => urlRef.current && URL.revokeObjectURL(urlRef.current), []);

  const pickFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(f);
    urlRef.current = url;
    setSrc(url);
    setFileName(f.name);
    setDive(null);
    setTurn(null);
    setTouch(null);
    setResult(null);
    setCurrent(0);
    setPlaying(false);
    setDecodeError(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNote(null);
    setAuto(EMPTY_AUTO);
    setPosePct(null);
    setScanMs(null);
    setDroppedFrames(false);
    setScanRate(SCAN_RATE);
    e.target.value = "";
  };

  const onMeta = (e) => {
    const v = e.currentTarget;
    setDuration(isFinite(v.duration) ? v.duration : 0);
    setPortrait(v.videoHeight > v.videoWidth);
    if (!v.videoWidth) setDecodeError(true);
  };

  const seekTo = useCallback(
    (t) => {
      const v = videoRef.current;
      if (!v) return;
      const next = clamp(t, 0, duration || 0);
      v.currentTime = next;
      setCurrent(next);
    },
    [duration]
  );

  const pause = () => {
    const v = videoRef.current;
    if (v && !v.paused) {
      v.pause();
      setPlaying(false);
    }
  };

  const busy = () => scanning || posePct != null || linesPct != null;

  const step = (frames) => {
    const v = videoRef.current;
    if (!v || busy()) return;
    pause();
    const target = clamp(v.currentTime + frames / fps, 0, duration || 0);
    v.currentTime = target;
    if (v.requestVideoFrameCallback)
      v.requestVideoFrameCallback((now, meta) => setCurrent(meta.mediaTime));
    else setCurrent(target);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || busy()) return;
    if (v.paused) {
      v.playbackRate = speed;
      v.play().catch(() => setDecodeError(true));
      setPlaying(true);
    } else pause();
  };

  const mark = (which) => {
    const v = videoRef.current;
    if (!v || busy()) return;
    const t = v.currentTime;
    ({ dive: setDive, turn: setTurn, touch: setTouch })[which](t);
    setFlash((n) => n + 1);
    setAuto((a) => ({ ...a, [which]: { ...a[which], source: "hand", unc: 0 } })); // a hand mark overrides the auto call
  };

  /* --- the scan -----------------------------------------------------------
     One muted pass at `rate`x into a 64px canvas, luma only. Two Uint8 luma
     grids are reused frame to frame (ping-pong); the only per-frame allocation
     is the retained diff grid, now Uint8 (~8 MB for a 37s clip, a quarter of
     the old Float32). If the device can't sample every frame at this rate the
     scan detects the shortfall and retries once at 8x. */
  const runScan = async (rate = scanRate) => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !duration) return;
    if (!v.requestVideoFrameCallback) {
      setNote("This browser can't sample video frames. Mark the swim by hand.");
      return;
    }
    const t0 = performance.now();
    setScanning(true);
    setScanPct(0);
    setNote(null);
    setResult(null);
    setDroppedFrames(false);
    pause();

    const H = Math.max(24, Math.round(SCAN_W * (v.videoHeight / v.videoWidth || 1.5)));
    c.width = SCAN_W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true, alpha: false });
    const N = SCAN_W * H;
    const samples = [];
    let gNow = new Uint8Array(N);   // this frame's luma
    let gPrev = new Uint8Array(N);  // previous frame's luma
    let havePrev = false;
    let detectedFps = null;
    let lastT = null;

    v.currentTime = 0;
    v.muted = true;
    v.playbackRate = rate;

    await new Promise((done) => {
      const onFrame = (now, meta) => {
        ctx.drawImage(v, 0, 0, SCAN_W, H);
        const px = ctx.getImageData(0, 0, SCAN_W, H).data;
        for (let i = 0, j = 0; j < N; i += 4, j++)
          gNow[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
        if (havePrev) {
          const cells = new Uint8Array(N);
          let changed = 0;
          for (let j = 0; j < N; j++) {
            const d = gNow[j] > gPrev[j] ? gNow[j] - gPrev[j] : gPrev[j] - gNow[j];
            cells[j] = d;
            if (d > 12) changed++;
          }
          samples.push({ t: meta.mediaTime, frac: changed / N, cells });
          if (lastT != null) {
            const dt = meta.mediaTime - lastT;
            if (dt > 0.002 && dt < 0.2) detectedFps = detectedFps ? detectedFps * 0.9 + (1 / dt) * 0.1 : 1 / dt;
          }
          lastT = meta.mediaTime;
        }
        havePrev = true;
        const tmp = gPrev; gPrev = gNow; gNow = tmp; // this frame becomes next frame's prev
        setScanPct(clamp(meta.mediaTime / duration, 0, 1));
        if (v.ended || meta.mediaTime >= duration - 0.05) return done();
        v.requestVideoFrameCallback(onFrame);
      };
      v.play().then(() => v.requestVideoFrameCallback(onFrame), () => done());
      setTimeout(done, Math.min(90000, (duration / rate) * 1000 + 15000));
    });

    v.pause();
    v.playbackRate = speed;
    setPlaying(false);
    setScanning(false);
    setScanPct(0);
    const elapsed = Math.round(performance.now() - t0);
    setScanMs(elapsed);

    /* One frame-rate notion: the EMA of real inter-frame gaps in mediaTime.
       samples.length/duration undercounts every time a frame is dropped; the
       old code fed that undercount to detect() while driving the UI off the
       EMA — two different numbers for the same thing. */
    const emaFps = detectedFps && detectedFps > 10 ? detectedFps : null;
    const effFps = emaFps || samples.length / Math.max(duration, 0.001) || 30;

    /* Frame-yield guard. `requestVideoFrameCallback` only fires for frames the
       browser actually *presents*, and at high playback rates it presents far
       fewer than it decodes — Chrome yields ~11% of frames at 16x, ~25% at 8x,
       ~94% at 2x. Safari presents every frame even at 16x. So step the rate
       down until the yield is good enough for detect() to read, or bottom out
       at 2x. Each clip is ~30fps; duration*30 is close enough for the ratio. */
    const expected = duration * 30;
    const yield_ = samples.length / Math.max(expected, 1);
    const LADDER = [16, 8, 4, 2];
    if (yield_ < 0.85 && rate > 2) {
      const next = yield_ < 0.3 ? 2 : LADDER[LADDER.indexOf(rate) + 1] || 2;
      setDroppedFrames(true);
      setNote(`This browser sampled only ${Math.round(yield_ * 100)}% of the frames at ${rate}× — rescanning at ${next}× (slower, but reads every frame).`);
      setScanRate(next);
      return runScan(next);
    }
    if (yield_ < 0.85) {
      setDroppedFrames(true);
      setNote(`Sampled ${samples.length} of ~${Math.round(expected)} frames even at ${rate}×. The trace and times below are coarser than the frame rate suggests.`);
    } else {
      setDroppedFrames(false);
    }

    const r = detect(samples, effFps);
    if (r.error) {
      setNote(r.error);
      return;
    }
    setResult(r);
    const snapped = [24, 25, 30, 50, 60, 120, 240].reduce((a, b) => (Math.abs(b - effFps) < Math.abs(a - effFps) ? b : a));
    if (Math.abs(snapped - fps) > 3) setFps(snapped);

    /* --- place the marks straight away so the scan hands back a time ------
       detect() picks the dive and the touch off the loudest moments in the
       water (step 6 there). Both are a rough read of the motion signal, not a
       frame-accurate call — the ± reflects that, and "Pin the dive with pose"
       tightens the dive to ±2 frames. The wall stays a hand check. */
    let nextAuto = { ...EMPTY_AUTO };
    effFpsRef.current = effFps;
    let autoDive = r.dive;
    let autoTouch = r.touch;

    /* If there's a training history, use its median total as a prior: snap the
       touch to whichever candidate lands closest to dive + that time. Cheap way
       to lean on "my two lengths are always about 13.5s". */
    if (autoDive != null && swims.length >= 2 && r.candidates.length) {
      const totals = swims.map((s) => s.total).filter((x) => x > 0).sort((a, b) => a - b);
      const med = totals[totals.length >> 1];
      if (med > 3) {
        const target = autoDive + med;
        const near = r.candidates
          .filter((c) => c.t > autoDive + 1)
          .reduce((best, c) => (best && Math.abs(best.t - target) <= Math.abs(c.t - target) ? best : c), null);
        if (near) autoTouch = near.t;
      }
    }

    if (autoDive != null) {
      setDive(autoDive);
      nextAuto.dive = { source: "guess", unc: 12 };
    }
    if (autoTouch != null) {
      setTouch(autoTouch);
      nextAuto.touch = { source: "guess", unc: 12 };
    }
    setAuto(nextAuto);
    if (autoDive != null) seekTo(autoDive);

    if (autoDive != null && autoTouch != null) {
      setNote(
        `Scanned in ${(elapsed / 1000).toFixed(1)}s — ${(autoTouch - autoDive).toFixed(2)}s, dive to touch. ` +
          `Both marks are from the loudest splashes (± a few tenths). "Pin the dive with pose" tightens the ` +
          `dive; step through and re-mark either if they look off.`
      );
    } else {
      setNote(
        `Scanned in ${(elapsed / 1000).toFixed(1)}s. Couldn't pick out a clean dive and finish — tap a ` +
          `candidate below to jump there and mark Dive / Touch by hand.`
      );
    }
  };

  const wallLine = (a) =>
    a.touch.source === "guess"
      ? `The wall is a guess (±${a.touch.unc} frames) — step to it and confirm. `
      : `Tap a candidate near the finish and mark the wall yourself. `;

  const runDivePose = async () => {
    const r = result;
    const effFps = effFpsRef.current;
    const a = auto;
    if (!r) return;
    let mod;
    try {
      mod = await import("./dive-pose.js");
    } catch {
      setNote(`Pose model unavailable here, so the dive is a guess from the loudest early moment. ${wallLine(a)}`);
      return;
    }
    const v = videoRef.current;
    if (!v || !mod?.detectDive) {
      setNote(`Pose model unavailable here, so the dive is a guess from the loudest early moment. ${wallLine(a)}`);
      return;
    }
    // the scan just played to the end; rewind and land a real frame before the
    // pose pass so its first seeks don't read a stale/blank buffer
    try {
      v.pause();
      v.currentTime = Math.max(0, r.steadyFrom);
      await new Promise((res) => {
        const to = setTimeout(res, 1500);
        v.requestVideoFrameCallback(() => { clearTimeout(to); res(); });
      });
    } catch { /* best effort */ }
    setPosePct(0);
    let slow = false;
    try {
      // phases arrive as "localize" (0–0.3) → "coarse" (0.3–0.6) → "fine" (0.6–1)
      const phaseBase = { localize: 0, coarse: 0.3, fine: 0.6 };
      const phaseSpan = { localize: 0.3, coarse: 0.3, fine: 0.4 };
      const hit = await mod.detectDive({
        video: v,
        fps: effFps,
        searchFrom: Math.max(0, r.steadyFrom),
        searchTo: r.steadyTo,
        onProgress: ({ phase, done, total, slow: s }) => {
          if (s) slow = true;
          const b = phaseBase[phase] ?? 0;
          const sp = phaseSpan[phase] ?? 1;
          setPosePct(total ? clamp(b + sp * (done / total), 0, 1) : b);
        },
      });
      const slowNote = slow ? " (ran on the slow CPU path — no graphics acceleration here)" : "";
      if (hit && hit.t != null) {
        setDive(hit.t);
        setAuto((prev) => ({ ...prev, dive: { source: "pose", unc: hit.uncertaintyFrames ?? 2 } }));
        seekTo(hit.t);
        setNote(`Dive placed from the on-deck pose (±${hit.uncertaintyFrames ?? 2} frames)${slowNote}. ${wallLine(a)}The turn isn't auto-placed — the far wall is too far from this camera.`);
      } else {
        // keep the motion-scan seed (already flagged 'guess'); pose just couldn't improve it
        setNote(`Couldn't see the swimmer on the deck. The dive is a guess from the loudest early moment — check it. ${wallLine(a)}`);
      }
    } catch {
      setNote(`The pose pass failed, so the dive is a guess from the loudest early moment. ${wallLine(a)}`);
    } finally {
      setPosePct(null);
      const vv = videoRef.current;
      if (vv) {
        vv.pause();
        vv.playbackRate = speed;
        setPlaying(false);
      }
    }
  };

  /* --- wall-crossing pass (opt-in) ---------------------------------------
     Only useful when the clip is shot side-on with both end walls in frame
     and the water line roughly horizontal. It can't be told from the loudness
     signal whether a clip is like that, so this runs on request rather than on
     every scan, and it captures its own wider (~160px) frame stack. When the
     geometry cooperates it places all three events; otherwise it says why. */
  const runLines = async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !duration || !v.requestVideoFrameCallback) return;
    let mod;
    try {
      mod = await import("./detect-lines.js");
    } catch {
      setNote("Wall-crossing detection isn't available in this build.");
      return;
    }
    setLinesPct(0);
    pause();

    const W = 160;
    const H = Math.max(24, Math.round(W * (v.videoHeight / v.videoWidth || 1.5)));
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true, alpha: false });
    const N = W * H;
    const stride = Math.max(1, Math.round((duration * 30) / 1400)); // cap the stack near 1400 frames
    const stack = [];
    let f = 0;

    v.currentTime = 0;
    v.muted = true;
    v.playbackRate = SCAN_RATE;
    await new Promise((done) => {
      const onFrame = (now, meta) => {
        if (f++ % stride === 0) {
          ctx.drawImage(v, 0, 0, W, H);
          const px = ctx.getImageData(0, 0, W, H).data;
          const g = new Uint8Array(N);
          for (let i = 0, j = 0; j < N; i += 4, j++)
            g[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
          stack.push({ data: g, t: meta.mediaTime });
        }
        setLinesPct(clamp(meta.mediaTime / duration, 0, 1));
        if (v.ended || meta.mediaTime >= duration - 0.05) return done();
        v.requestVideoFrameCallback(onFrame);
      };
      v.play().then(() => v.requestVideoFrameCallback(onFrame), () => done());
      setTimeout(done, Math.min(90000, (duration / SCAN_RATE) * 1000 + 15000));
    });
    v.pause();
    v.playbackRate = speed;
    setPlaying(false);
    setLinesPct(null);

    try {
      const fps = stack.length / Math.max(duration, 0.001);
      const r = mod.detectLines(
        { count: stack.length, width: W, height: H, fps, at: (i) => stack[i].data, t: (i) => stack[i].t },
        {}
      );
      const got = [];
      const place = (k, val, setter) => {
        if (val == null) return;
        setter(val);
        const uncFrames = Math.max(2, Math.round((r.uncertainty?.[k] ?? 0.2) * fps));
        setAuto((prev) => ({ ...prev, [k]: { source: "lines", unc: uncFrames } }));
        got.push(k);
      };
      place("dive", r.dive, setDive);
      place("turn", r.turn, setTurn);
      place("touch", r.touch, setTouch);
      if (got.length) {
        if (r.dive != null) seekTo(r.dive);
        setNote(`Wall crossings found — placed ${got.join(", ")} from where the swimmer crosses the end-wall lines. Step to each and confirm.`);
      } else {
        setNote(`No usable wall geometry in this clip: ${r.diagnostics?.reason || (r.notes || []).join(" ") || "the end walls aren't both visible with the water line level."}`);
      }
    } catch (err) {
      setNote("Wall-crossing detection couldn't read this clip.");
    }
  };

  /* --- pan / rail --------------------------------------------------------- */
  const ratioFrom = (e) => {
    const el = railRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const onRailDown = (e) => {
    if (!duration || busy()) return;
    pause();
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(ratioFrom(e) * duration);
  };
  const onRailMove = (e) => {
    if (!duration || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    seekTo(ratioFrom(e) * duration);
  };
  const onRailKey = (e) => {
    const n = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight") { e.preventDefault(); step(n); }
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-n); }
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
  };
  const onStageDown = (e) => {
    panRef.current = { dragging: true, moved: false, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onStageMove = (e) => {
    const p = panRef.current;
    if (!p.dragging || zoom === 1) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) p.moved = true;
    p.x = e.clientX; p.y = e.clientY;
    /* The transform is scale() then translate(), so translate is in pre-scale
       units: a dx-pixel drag moves the frame dx/zoom. Max offset before the
       edge shows is half the overflow, also in pre-scale units. Fall back to
       the old crude constant only if the box hasn't measured yet. */
    const el = videoRef.current;
    const limX = el?.clientWidth ? ((zoom - 1) / (2 * zoom)) * el.clientWidth : (zoom - 1) * 50;
    const limY = el?.clientHeight ? ((zoom - 1) / (2 * zoom)) * el.clientHeight : (zoom - 1) * 50;
    setPan((o) => ({ x: clamp(o.x + dx / zoom, -limX, limX), y: clamp(o.y + dy / zoom, -limY, limY) }));
  };
  const onStageUp = () => {
    if (!panRef.current.moved) togglePlay();
    panRef.current.dragging = false;
  };

  /* --- results ------------------------------------------------------------ */
  const valid = dive != null && touch != null && touch > dive;
  const total = valid ? touch - dive : null;
  const lap1 = valid && turn != null && turn > dive && turn < touch ? turn - dive : null;
  const lap2 = lap1 != null ? total - lap1 : null;
  const metres = COURSES.find((c) => c.id === course).metres;
  const pace100 = total ? (total / metres) * 100 : null;
  const bestTime = swims.length ? Math.min(...swims.map((s) => s.total)) : null;
  const frameMs = 1000 / fps;

  /* The ± on the total is the two end marks' uncertainty added in quadrature,
     never finer than one frame. A hand mark contributes one frame; a pose mark
     ~2; a motion-scan guess whatever the scan was willing to stand behind. */
  const markUncS = (k) => Math.max(1, auto[k].source === "hand" ? 1 : auto[k].unc || 1) * (frameMs / 1000);
  const totalUncS = valid ? Math.hypot(markUncS("dive"), markUncS("touch")) : null;
  const shaky = valid && (auto.dive.source === "guess" || auto.touch.source === "guess");

  const saveSwim = () => {
    if (!valid) return;
    persist([{ id: Date.now(), total, lap1, lap2, course, when: new Date().toISOString(), file: fileName || "clip" }, ...swims].slice(0, 40));
  };

  const [exported, setExported] = useState(false);
  const exportSwims = async () => {
    if (!swims.length) return;
    const head = "when,course,total,length1,length2,per100,file";
    const rows = swims.map((s) => {
      const m = COURSES.find((c) => c.id === s.course)?.metres;
      const per100 = m ? ((s.total / m) * 100).toFixed(2) : "";
      return [s.when, s.course, s.total?.toFixed(2) ?? "", s.lap1?.toFixed(2) ?? "",
        s.lap2?.toFixed(2) ?? "", per100, `"${(s.file || "").replace(/"/g, '""')}"`].join(",");
    });
    const csv = [head, ...rows].join("\n");
    try {
      await navigator.clipboard.writeText(csv);
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    } catch {
      /* clipboard blocked — fall back to a download where the sandbox allows it */
      try {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "swims.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        setNote("Couldn't copy or download the log in this browser.");
      }
    }
  };

  const p = (t) => (duration ? clamp((t / duration) * 100, 0, 100) : 0);
  const tracePath = () => {
    const tr = result?.trace;
    if (!tr || !duration) return "";
    const max = Math.max(...tr.map((s) => s.v)) || 1;
    const pts = tr.map((s) => `${(s.t / duration) * 100},${26 - (s.v / max) * 24}`);
    return `M0,26 L${pts.join(" L")} L100,26 Z`;
  };

  /* One line of provenance per mark: how it was placed and how far to trust it. */
  const markStatus = (key) => {
    const s = auto[key];
    if (s.source === "hand") return "marked by hand";
    if (s.source === "pose") return `from the on-deck pose · ±${s.unc} frames`;
    if (s.source === "lines") return `from the wall crossing · ±${s.unc} frames`;
    if (s.source === "guess") return `from the scan · ±${s.unc} frames · adjust if it looks off`;
    if (key === "turn") return "not auto-placed — mark it if you want splits";
    return "not found — tap a candidate below and mark it";
  };

  const MARKS = [
    { key: "dive", label: "Dive in", sub: "feet leave the deck", val: dive, set: setDive, c: "#fff" },
    { key: "turn", label: "Turn", sub: "far wall — hand or push-off", val: turn, set: setTurn, c: "#999" },
    { key: "touch", label: "Touch", sub: "hand hits the wall", val: touch, set: setTouch, c: "#ccc" },
  ];

  return (
    <div className="pool">
      <div className="app-header">
        <div className="app-logo">▶</div>
        <div>
          <div className="app-title">SWIM TIMER</div>
          <div className="app-subtitle">dive to touch // frame-accurate</div>
        </div>
      </div>
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {!src ? (
        <div className="empty" style={{ marginTop: 16 }}>
          <div className="swim-scene" aria-hidden="true">
            <div className="lane-line lane-top" />
            <div className="lane-line lane-bot" />
            <div className="swimmer-wrap">
              <div className="swimmer">
                <div className="pixel-swimmer" />
              </div>
              <div className="splash s1" />
              <div className="splash s2" />
              <div className="splash s3" />
            </div>
            <div className="ripple r1" />
            <div className="ripple r2" />
            <div className="ripple r3" />
          </div>
          <div className="eyebrow">Step one</div>
          <h2>Load a swim</h2>
          <p>Pick a clip from your camera roll. It plays off your device — nothing is uploaded.</p>
          <label className="file">
            Choose video<input type="file" accept="video/*" onChange={pickFile} />
          </label>
          <p className="hint">
            Side-on to the pool beats filming down the lane. From behind the block your own splash
            covers the touch.
          </p>
        </div>
      ) : (
        <>
          <div className="board">
            <div className="eyebrow">Total</div>
            <span key={flash} className={`mono clock ${total ? "hit" : "dim"}`}>{clockText(total)}</span>
            {total != null && (
              <div className="pm mono">
                ± {(totalUncS ?? frameMs / 1000).toFixed(2)}s
                {shaky ? " — from the scan; refine below if it matters" : ` at ${fps} fps`}
              </div>
            )}
            <div className="splits">
              <div className="split"><div className="eyebrow">Length 1</div><div className="mono v">{clockText(lap1)}</div></div>
              <div className="split"><div className="eyebrow">Length 2</div><div className="mono v">{clockText(lap2)}</div></div>
              <div className="split"><div className="eyebrow">Per 100</div><div className="mono v">{clockText(pace100)}</div></div>
            </div>
            {dive != null && touch != null && touch <= dive && (
              <div className="warn">The touch sits before the dive. Re-mark one of them.</div>
            )}
          </div>

          {decodeError ? (
            <div className="empty">
              <h2>This browser can't play the clip</h2>
              <p>iPhone clips are HEVC, which Safari plays and most other browsers don't. In Photos, share the video and choose Most Compatible.</p>
              <label className="file">Try another video<input type="file" accept="video/*" onChange={pickFile} /></label>
            </div>
          ) : (
            <>
              <div className="stage" onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp}
                style={{ maxHeight: portrait ? "58vh" : "42vh" }}>
                <video ref={videoRef} src={src} playsInline preload="auto"
                  onLoadedMetadata={onMeta} onError={() => setDecodeError(true)}
                  onSeeked={(e) => setCurrent(e.currentTarget.currentTime)}
                  onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)}
                  style={{ maxHeight: portrait ? "58vh" : "42vh", width: portrait ? "auto" : "100%",
                    transform: `scale(${zoom}) translate(${pan.x}px,${pan.y}px)` }} />
                <div className="badge mono">{current.toFixed(2)}s</div>
                {scanning && <div className="scanbar" style={{ width: `${scanPct * 100}%` }} />}
                {posePct != null && (
                  <>
                    <div className="badge mono" style={{ left: "auto", right: 10 }}>finding the dive {Math.round(posePct * 100)}%</div>
                    <div className="scanbar" style={{ width: `${posePct * 100}%`, background: "var(--amber)" }} />
                  </>
                )}
                {linesPct != null && (
                  <>
                    <div className="badge mono" style={{ left: "auto", right: 10 }}>reading the walls {Math.round(linesPct * 100)}%</div>
                    <div className="scanbar" style={{ width: `${linesPct * 100}%`, background: "var(--amber)" }} />
                  </>
                )}
              </div>

              <div className="rail" ref={railRef} role="slider" tabIndex={0} aria-label="Video position"
                aria-valuemin={0} aria-valuemax={Math.round(duration * 100) / 100 || 0}
                aria-valuenow={Math.round(current * 100) / 100}
                onPointerDown={onRailDown} onPointerMove={onRailMove} onKeyDown={onRailKey}>
                {result && (
                  <svg className="trace" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                    <path d={tracePath()} fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.4)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
                  </svg>
                )}
                <div className="cord" />
                {result && result.steadyFrom > 0.05 && (
                  <div className="cam" style={{ left: 0, width: `${p(result.steadyFrom)}%` }} title="camera moving" />
                )}
                {result && result.steadyTo < duration - 0.05 && (
                  <div className="cam" style={{ left: `${p(result.steadyTo)}%`, width: `${100 - p(result.steadyTo)}%` }} />
                )}
                {valid && <div className="span" style={{ left: `${p(dive)}%`, width: `${p(touch) - p(dive)}%` }} />}
                {MARKS.filter((m) => m.val != null).map((m) => (
                  <div className="flag" key={m.key} style={{ left: `${p(m.val)}%` }}>
                    <u style={{ background: m.c }} /><i style={{ background: m.c }} />
                  </div>
                ))}
                <div className="head" style={{ left: `${p(current)}%` }} />
              </div>
              <div className="rails mono"><span>0.00</span><span>{duration.toFixed(2)}</span></div>

              <div className="row">
                <button className="btn" onClick={() => step(-10)}>⟪10f</button>
                <button className="btn" onClick={() => step(-1)}>⟨1f</button>
                <button className="btn on" onClick={togglePlay}>{playing ? "Pause" : "Play"}</button>
                <button className="btn" onClick={() => step(1)}>1f⟩</button>
                <button className="btn" onClick={() => step(10)}>10f⟫</button>
              </div>

              <div className="row seg">
                {SPEEDS.map((s) => (
                  <button key={s} className={`btn ${speed === s ? "on" : "ghost"}`} onClick={() => setSpeed(s)}>{s}×</button>
                ))}
                {ZOOMS.map((z) => (
                  <button key={z} className={`btn ${zoom === z ? "on" : "ghost"}`}
                    onClick={() => { setZoom(z); if (z === 1) setPan({ x: 0, y: 0 }); }}>
                    {z === 1 ? "fit" : `${z}×`}
                  </button>
                ))}
              </div>

              <div className="row">
                <button className={`btn on ${scanning ? 'scanning-active' : ''}`} onClick={() => runScan()} disabled={scanning || posePct != null || linesPct != null}>
                  {scanning
                    ? `Reading the water ${Math.round(scanPct * 100)}%`
                    : droppedFrames && !result
                    ? `Scan again at ${scanRate}×`
                    : result
                    ? "Scan again"
                    : "Scan & detect marks"}
                </button>
              </div>

              {result && (
                <div className="row">
                  <button className="btn ghost" onClick={runDivePose} disabled={scanning || posePct != null || linesPct != null}>
                    {posePct != null ? `Pinning the dive ${Math.round(posePct * 100)}%` : "Pin the dive with pose"}
                  </button>
                  <button className="btn ghost" onClick={runLines} disabled={scanning || posePct != null || linesPct != null}>
                    {linesPct != null ? `Reading the walls ${Math.round(linesPct * 100)}%` : "Side-on? Detect wall crossings"}
                  </button>
                </div>
              )}

              {result?.candidates?.length > 0 && (
                <div className="cands">
                  <span className="eyebrow" style={{ alignSelf: 'center', marginRight: 4 }}>Candidates</span>
                  {result.candidates.map((c, i) => (
                    <button key={i} className="cand-btn mono" onClick={() => seekTo(c.t)}>
                      {c.t.toFixed(2)}s
                    </button>
                  ))}
                </div>
              )}

              {note && <div className="note">{note}</div>}

              <div className="marks">
                {MARKS.map((m) => {
                  const st = auto[m.key];
                  const cls = ["pose", "lines", "hand"].includes(st.source) ? "ok" : st.source === "guess" ? "guess" : "";
                  return (
                    <div className={`mark ${cls}`} key={m.key} style={{ "--c": m.c }}>
                      <div className="who">
                        <b>{m.label}{m.val != null && <span className="mono val"> {m.val.toFixed(2)}s</span>}</b>
                        <span>{m.sub} · {markStatus(m.key)}</span>
                      </div>
                      {m.val != null && <button className="mini" onClick={() => seekTo(m.val)}>Go</button>}
                      {m.val != null && (
                        <button className="mini" onClick={() => { m.set(null); setAuto((a) => ({ ...a, [m.key]: { source: null, unc: null } })); }}>Clear</button>
                      )}
                      <button className="mini set" style={{ "--c": m.c }} onClick={() => mark(m.key)}>Mark here</button>
                    </div>
                  );
                })}
              </div>

              <div className="row">
                <button className="btn" onClick={() => { if (dive != null) { seekTo(Math.max(0, dive - 0.4)); const v = videoRef.current; v.playbackRate = speed; v.play(); setPlaying(true); } }} disabled={dive == null}>
                  Play the swim
                </button>
                <button className="btn on" onClick={saveSwim} disabled={!valid}>Save this swim</button>
              </div>

              <div className="settings-group">
                <div className="settings-label">Course</div>
                <div className="row seg" style={{ marginTop: 0 }}>
                  {COURSES.map((c) => (
                    <button key={c.id} className={`btn ${course === c.id ? "on" : "ghost"}`} onClick={() => setCourse(c.id)}>{c.label}</button>
                  ))}
                </div>
                <div className="settings-label" style={{ marginTop: 12 }}>Frame rate</div>
                <div className="row seg" style={{ marginTop: 0 }}>
                  {[30, 60, 120, 240].map((f) => (
                    <button key={f} className={`btn ${fps === f ? "on" : "ghost"}`} onClick={() => setFps(f)}>{f} fps</button>
                  ))}
                </div>
              </div>
              <div className="hint">
                {scanMs != null && `Scan took ${(scanMs / 1000).toFixed(1)}s. `}
                One frame = {frameMs.toFixed(1)} ms — that's the floor on this clip. The turn is
                never auto-placed: at the far wall the swimmer is smaller than the sparkle on the water.
                <label className="file" style={{ padding: "10px 16px", fontSize: 13, marginTop: 14 }}>
                  Load a different video<input type="file" accept="video/*" onChange={pickFile} />
                </label>
              </div>
            </>
          )}
        </>
      )}

      <div className="saved-section">
        <div className="saved-header">
          <div className="eyebrow">Saved swims {swims.length ? `· ${swims.length}` : ""}</div>
          {swims.length > 0 && (
            <button className="mini" onClick={exportSwims}>{exported ? "Copied ✓" : "Export CSV"}</button>
          )}
        </div>
        {swims.length === 0 ? (
          <div className="hint">Nothing saved yet. Scan a clip, confirm the marks, then save.</div>
        ) : (
          swims.map((s) => (
            <div className="entry" key={s.id}>
              <div className="mono t">{clockText(s.total)}</div>
              <div className="d">
                {COURSES.find((c) => c.id === s.course)?.label || s.course}
                {s.lap1 ? ` · ${s.lap1.toFixed(2)} / ${s.lap2.toFixed(2)}` : ""}
                {` · ${new Date(s.when).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
              </div>
              {s.total === bestTime && <div className="best">BEST</div>}
              <button className="x" onClick={() => persist(swims.filter((x) => x.id !== s.id))} aria-label="Delete swim">×</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
