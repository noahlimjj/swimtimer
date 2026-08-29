import React, { useState, useRef, useEffect, useCallback } from "react";

/* ---------------------------------------------------------------------------
   Detection pipeline. Every rule here was validated against real clips; the
   comments say which failure each one fixes.
   --------------------------------------------------------------------------- */

const SCAN_W = 64;        // analysis grid width
const SCAN_RATE = 16;     // playback multiplier during the scan
const CAM_FRAC = 0.25;    // share of pixels changing that means the phone moved
const CAM_MARGIN = 0.45;  // seconds of margin around handled frames

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pct = (a, p) => {
  const s = Float32Array.from(a).sort();
  return s[clamp(Math.floor((p / 100) * s.length), 0, s.length - 1)];
};

function detect(samples, fps) {
  // samples: [{t, frac, cells:Float32Array}]  cells = per-cell abs difference
  const n = samples.length;
  if (n < 20) return { error: "Too few frames to read. Try again." };

  /* 1. Camera-handling gate.
     A person walking through frame changes a minority of pixels; the phone
     being set down or picked up changes most of them. An earlier version
     watched only the top of the frame for this, and threw away a whole dive
     because the swimmer's back filled the sky. Counting the share of changed
     pixels across the whole frame separates the two cleanly. */
  const steady = samples.map((s) => s.frac <= CAM_FRAC);
  const k = Math.max(1, Math.round(CAM_MARGIN * fps));
  const gated = steady.slice();
  for (let i = 0; i < n; i++)
    if (!steady[i])
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) gated[j] = false;
  const stableIdx = [];
  for (let i = 0; i < n; i++) if (gated[i]) stableIdx.push(i);
  if (stableIdx.length < fps * 2)
    return { error: "The camera moves for nearly the whole clip. Prop the phone up and reshoot." };

  /* 2. Water region: cells whose brightness varies over the steady frames.
     Deck and sky barely vary; the pool does. Measuring motion only inside it
     keeps deck movement from competing with the swim. */
  const cellCount = samples[0].cells.length;
  const mean = new Float32Array(cellCount);
  const varr = new Float32Array(cellCount);
  for (const i of stableIdx) for (let c = 0; c < cellCount; c++) mean[c] += samples[i].cells[c];
  for (let c = 0; c < cellCount; c++) mean[c] /= stableIdx.length;
  for (const i of stableIdx)
    for (let c = 0; c < cellCount; c++) {
      const d = samples[i].cells[c] - mean[c];
      varr[c] += d * d;
    }
  const vcut = pct(varr, 60);
  const roi = [];
  for (let c = 0; c < cellCount; c++) if (varr[c] > vcut) roi.push(c);
  if (roi.length < 20) return { error: "Couldn't find the water. Get more of the pool in frame." };

  /* 3. Water motion per frame. */
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of roi) s += samples[i].cells[c];
    e[i] = s / roi.length;
  }
  const eStable = stableIdx.map((i) => e[i]);
  /* Baseline from a low percentile, not the median. The median is dominated by
     the swim itself in a clip that is mostly swimming, which pushed the
     threshold above the swim and split it into fragments. */
  const base = pct(eStable, 10);
  const hi = pct(eStable, 97);
  const thr = base + 0.3 * (hi - base);

  /* 4. The swim is the longest sustained run of disturbed water. A swimmer
     walking into frame makes a louder spike than the dive, but it does not
     sustain, so it loses to the swim on length. */
  const gap = Math.round(0.6 * fps);
  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const active = e[i] > thr && gated[i];
    if (active) cur = cur ? [cur[0], i] : [i, i];
    else if (cur && i - cur[1] > gap) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  const long = runs.filter((r) => (r[1] - r[0]) / fps > 1.5);
  const [s0, s1] = long.length
    ? long.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a))
    : [stableIdx[0], stableIdx[stableIdx.length - 1]];

  /* 5. Entry. The loudest frame in the first two seconds of the run is the
     entry splash. Where takeoff sits relative to that peak is not fixed: on one
     clip the peak trailed the feet leaving by a frame, on another it led by six,
     because an arm swing can break the water before the feet go. So the peak
     is reported as the centre of a review window, never as the answer. */
  let pk = s0;
  const lookEnd = Math.min(s0 + Math.round(2 * fps), s1);
  for (let i = s0; i <= lookEnd; i++) if (e[i] > e[pk]) pk = i;

  /* 6. Arrival. Take the leading edge of the last big surge rather than its
     peak: the peak is the swimmer thrashing at the wall after the touch. */
  const halfway = Math.round((s0 + s1) / 2);
  let ap = halfway;
  for (let i = halfway; i <= s1; i++) if (e[i] > e[ap]) ap = i;
  const edge = base + 0.75 * (e[ap] - base);
  let arrive = ap;
  while (arrive > halfway && e[arrive - 1] > edge) arrive--;

  return {
    steadyFrom: samples[stableIdx[0]].t,
    steadyTo: samples[stableIdx[stableIdx.length - 1]].t,
    swim: [samples[s0].t, samples[s1].t],
    dive: samples[pk].t,
    touch: samples[arrive].t,
    touchPeak: samples[ap].t,
    trace: samples.map((s, i) => ({ t: s.t, v: e[i], ok: gated[i] })),
    roiFrac: roi.length / cellCount,
  };
}

/* ------------------------------------------------------------------------- */

const SPEEDS = [1, 0.5, 0.25, 0.1];
const ZOOMS = [1, 2, 3];
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
  const [note, setNote] = useState(null);
  const [review, setReview] = useState(null); // 'dive' | 'touch' | null

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
    setReview(null);
    setScanMs(null);
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

  const step = (frames) => {
    const v = videoRef.current;
    if (!v) return;
    pause();
    const target = clamp(v.currentTime + frames / fps, 0, duration || 0);
    v.currentTime = target;
    if (v.requestVideoFrameCallback)
      v.requestVideoFrameCallback((now, meta) => setCurrent(meta.mediaTime));
    else setCurrent(target);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.playbackRate = speed;
      v.play().catch(() => setDecodeError(true));
      setPlaying(true);
    } else pause();
  };

  const mark = (which) => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    ({ dive: setDive, turn: setTurn, touch: setTouch })[which](t);
    setFlash((n) => n + 1);
    if (review === which) setReview(which === "dive" ? "touch" : null);
  };

  /* --- the scan -----------------------------------------------------------
     One pass, at 16x playback into a 64px canvas. The old version played at 4x
     and did the arithmetic on full RGBA; this reads luma only and skips the
     per-frame allocation, which is where the time was going. */
  const runScan = async () => {
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
    pause();

    const H = Math.max(24, Math.round(SCAN_W * (v.videoHeight / v.videoWidth || 1.5)));
    c.width = SCAN_W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true, alpha: false });
    const N = SCAN_W * H;
    const samples = [];
    let prev = null;
    let detectedFps = null;
    let lastT = null;

    v.currentTime = 0;
    v.muted = true;
    v.playbackRate = SCAN_RATE;

    await new Promise((done) => {
      const onFrame = (now, meta) => {
        ctx.drawImage(v, 0, 0, SCAN_W, H);
        const px = ctx.getImageData(0, 0, SCAN_W, H).data;
        const g = new Float32Array(N);
        for (let i = 0, j = 0; j < N; i += 4, j++)
          g[j] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        if (prev) {
          const cells = new Float32Array(N);
          let changed = 0;
          for (let j = 0; j < N; j++) {
            const d = Math.abs(g[j] - prev[j]);
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
        prev = g;
        setScanPct(clamp(meta.mediaTime / duration, 0, 1));
        if (v.ended || meta.mediaTime >= duration - 0.05) return done();
        v.requestVideoFrameCallback(onFrame);
      };
      v.play().then(() => v.requestVideoFrameCallback(onFrame), () => done());
      setTimeout(done, Math.min(90000, (duration / SCAN_RATE) * 1000 + 15000));
    });

    v.pause();
    v.playbackRate = speed;
    setPlaying(false);
    setScanning(false);
    setScanPct(0);
    setScanMs(Math.round(performance.now() - t0));

    const eff = detectedFps && detectedFps > 10 ? detectedFps : 30;
    const sampleFps = samples.length / Math.max(duration, 0.001);
    const r = detect(samples, sampleFps);
    if (r.error) {
      setNote(r.error);
      return;
    }
    setResult(r);
    if (Math.abs(eff - fps) > 3) setFps([24, 25, 30, 50, 60, 120, 240].reduce((a, b) => (Math.abs(b - eff) < Math.abs(a - eff) ? b : a)));
    setDive(r.dive);
    setTouch(r.touch);
    seekTo(r.dive);
    setReview("dive");
    setFlash((n) => n + 1);
    setNote(
      `Scanned in ${((performance.now() - t0) / 1000).toFixed(1)}s. Both marks are placed from the water, ` +
        `not measured off your body — step through and confirm each one.`
    );
  };

  /* --- pan / rail --------------------------------------------------------- */
  const ratioFrom = (e) => {
    const el = railRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  const onRailDown = (e) => {
    if (!duration || scanning) return;
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
    const lim = (zoom - 1) * 50;
    setPan((o) => ({ x: clamp(o.x + dx / 3, -lim, lim), y: clamp(o.y + dy / 3, -lim, lim) }));
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

  const saveSwim = () => {
    if (!valid) return;
    persist([{ id: Date.now(), total, lap1, lap2, course, when: new Date().toISOString(), file: fileName || "clip" }, ...swims].slice(0, 40));
  };

  const p = (t) => (duration ? clamp((t / duration) * 100, 0, 100) : 0);
  const tracePath = () => {
    const tr = result?.trace;
    if (!tr || !duration) return "";
    const max = Math.max(...tr.map((s) => s.v)) || 1;
    const pts = tr.map((s) => `${(s.t / duration) * 100},${26 - (s.v / max) * 24}`);
    return `M0,26 L${pts.join(" L")} L100,26 Z`;
  };

  const MARKS = [
    { key: "dive", label: "Dive in", sub: "feet leave the deck", val: dive, set: setDive, c: "var(--water)" },
    { key: "turn", label: "Turn", sub: "not auto-detected — mark it if you want splits", val: turn, set: setTurn, c: "var(--amber)" },
    { key: "touch", label: "Touch", sub: "hand hits the wall", val: touch, set: setTouch, c: "var(--pennant)" },
  ];

  return (
    <div className="pool">
      <style>{`
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;800&family=Martian+Mono:wght@400;600;700&display=swap');
.pool{--ink:#07141A;--deck:#0E2029;--panel:#122B36;--line:#1E4453;--text:#E6F4F7;--muted:#7DA3B1;
  --water:#2FD4E4;--amber:#FFB454;--pennant:#FF5C63;min-height:100vh;
  background:radial-gradient(120% 80% at 50% -10%,#123543 0%,var(--ink) 62%);color:var(--text);
  font-family:'Archivo',ui-sans-serif,system-ui,sans-serif;padding:18px 14px 44px;box-sizing:border-box}
.pool *{box-sizing:border-box}
.mono{font-family:'Martian Mono',ui-monospace,SFMono-Regular,monospace;font-variant-numeric:tabular-nums}
.eyebrow{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);font-weight:600}
.board{border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,#0F2632,#0A1D26);
  padding:16px;margin:12px 0 14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.clock{font-size:clamp(46px,17vw,76px);line-height:.92;font-weight:700;letter-spacing:-.03em;display:block;margin:6px 0 2px}
.clock.dim{color:#2E5364}
.clock.hit{animation:pop .35s ease-out}
@keyframes pop{0%{transform:scale(1.035);color:var(--water)}100%{transform:scale(1)}}
.pm{font-size:12px;color:var(--muted);margin-top:2px}
.splits{display:flex;margin-top:10px;border-top:1px solid var(--line);padding-top:10px}
.split{flex:1}.split+.split{border-left:1px solid var(--line);padding-left:12px}
.split .v{font-size:19px;font-weight:600;margin-top:3px}
.warn{color:var(--pennant);font-size:12px;margin-top:8px;font-weight:600}
.stage{border-radius:14px;overflow:hidden;background:#000;border:1px solid var(--line);position:relative;
  touch-action:none;display:flex;align-items:center;justify-content:center}
.stage video{width:100%;display:block;transition:transform .12s linear}
.badge{position:absolute;left:10px;top:10px;background:rgba(7,20,26,.72);border:1px solid var(--line);
  border-radius:999px;padding:4px 10px;font-size:11px;font-weight:600;pointer-events:none}
.scanbar{position:absolute;left:0;bottom:0;height:3px;background:var(--water)}
.rail{margin:14px 0 4px;height:78px;position:relative;touch-action:none;outline:none}
.rail:focus-visible .cord{box-shadow:0 0 0 2px var(--water)}
.trace{position:absolute;left:0;right:0;top:0;height:28px;width:100%;display:block}
.cord{position:absolute;left:0;right:0;top:44px;height:13px;border-radius:7px;overflow:hidden;
  background:repeating-linear-gradient(90deg,#1B3E4C 0 9px,#16323E 9px 18px)}
.span{position:absolute;top:44px;height:13px;border-radius:7px;opacity:.55;
  background:repeating-linear-gradient(90deg,var(--water) 0 9px,#1E8C9A 9px 18px)}
.cam{position:absolute;top:44px;height:13px;background:repeating-linear-gradient(45deg,#33202a 0 4px,#241820 4px 8px);border-radius:3px}
.head{position:absolute;top:30px;width:2px;height:35px;background:var(--text)}
.head::after{content:'';position:absolute;left:-4px;top:-5px;width:10px;height:10px;border-radius:50%;background:var(--text)}
.flag{position:absolute;top:24px}
.flag i{position:absolute;width:14px;height:11px;display:block;clip-path:polygon(0 0,100% 0,0 100%)}
.flag u{position:absolute;width:2px;height:34px;display:block;opacity:.75}
.rails{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
.row{display:flex;gap:8px;margin-top:10px}
.btn{flex:1;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:11px;
  padding:13px 6px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.35;cursor:default}
.btn.on{background:var(--water);border-color:var(--water);color:#04171C}
.btn.ghost{background:transparent}
.seg .btn{padding:9px 4px;font-size:12.5px}
.marks{display:grid;gap:8px;margin-top:16px}
.mark{border:1px solid var(--line);border-radius:12px;background:var(--deck);padding:10px 10px 10px 14px;
  display:flex;align-items:center;gap:8px;position:relative;overflow:hidden}
.mark.focus{border-color:var(--c);background:#16323d}
.mark::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c)}
.mark .who{flex:1;min-width:0}
.mark .who b{display:block;font-size:14px}
.mark .who span{font-size:11.5px;color:var(--muted)}
.mini{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:9px 10px;
  font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;flex:none}
.mini.set{background:var(--c);border-color:var(--c);color:#04171C}
.note{background:var(--deck);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:10px;
  padding:11px 13px;font-size:12.5px;line-height:1.5;margin-top:12px}
.entry{display:flex;align-items:center;gap:12px;border-top:1px solid var(--line);padding:11px 2px}
.entry .t{font-size:19px;font-weight:600;min-width:88px}
.entry .d{flex:1;font-size:11.5px;color:var(--muted)}
.best{font-size:9.5px;letter-spacing:.14em;color:var(--amber);border:1px solid var(--amber);border-radius:4px;padding:2px 5px;font-weight:700}
.x{background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 6px;font-family:inherit}
.empty{border:1px dashed var(--line);border-radius:16px;padding:34px 22px;text-align:center;background:var(--deck)}
.empty h2{font-size:20px;margin:12px 0 6px;font-weight:800}
.empty p{color:var(--muted);font-size:13.5px;margin:0 auto;max-width:34ch;line-height:1.5}
.file{display:inline-block;margin-top:18px;background:var(--water);color:#04171C;border-radius:11px;
  padding:14px 22px;font-weight:700;font-size:15px;cursor:pointer}
.file input{display:none}
.hint{color:var(--muted);font-size:11.5px;margin-top:12px;line-height:1.55}
@media (prefers-reduced-motion:reduce){.clock.hit{animation:none}.stage video{transition:none}}
      `}</style>

      <div className="eyebrow">Dive to touch · 2 lengths</div>
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {!src ? (
        <div className="empty" style={{ marginTop: 16 }}>
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
            {total != null && <div className="pm mono">± {(frameMs / 1000).toFixed(2)}s at {fps} fps</div>}
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
              </div>

              <div className="rail" ref={railRef} role="slider" tabIndex={0} aria-label="Video position"
                aria-valuemin={0} aria-valuemax={Math.round(duration * 100) / 100 || 0}
                aria-valuenow={Math.round(current * 100) / 100}
                onPointerDown={onRailDown} onPointerMove={onRailMove} onKeyDown={onRailKey}>
                {result && (
                  <svg className="trace" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                    <path d={tracePath()} fill="rgba(47,212,228,.28)" stroke="var(--water)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
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
                <button className="btn on" onClick={runScan} disabled={scanning}>
                  {scanning ? `Reading the water ${Math.round(scanPct * 100)}%` : result ? "Scan again" : "Scan and place marks"}
                </button>
              </div>

              {note && <div className="note">{note}</div>}

              <div className="marks">
                {MARKS.map((m) => (
                  <div className={`mark ${review === m.key ? "focus" : ""}`} key={m.key} style={{ "--c": m.c }}>
                    <div className="who">
                      <b>{m.label}{review === m.key ? " — confirm this" : ""}</b>
                      <span className="mono">{m.val != null ? `${m.val.toFixed(2)}s` : "not set"} — {m.sub}</span>
                    </div>
                    {m.val != null && <button className="mini" onClick={() => { seekTo(m.val); setReview(m.key); }}>Go</button>}
                    {m.val != null && <button className="mini" onClick={() => m.set(null)}>Clear</button>}
                    <button className="mini set" style={{ "--c": m.c }} onClick={() => mark(m.key)}>Mark</button>
                  </div>
                ))}
              </div>

              <div className="row">
                <button className="btn" onClick={() => { if (dive != null) { seekTo(Math.max(0, dive - 0.4)); const v = videoRef.current; v.playbackRate = speed; v.play(); setPlaying(true); } }} disabled={dive == null}>
                  Play the swim
                </button>
                <button className="btn on" onClick={saveSwim} disabled={!valid}>Save this swim</button>
              </div>

              <div className="row seg" style={{ marginTop: 16 }}>
                {COURSES.map((c) => (
                  <button key={c.id} className={`btn ${course === c.id ? "on" : "ghost"}`} onClick={() => setCourse(c.id)}>{c.label}</button>
                ))}
              </div>
              <div className="row seg">
                {[30, 60, 120, 240].map((f) => (
                  <button key={f} className={`btn ${fps === f ? "on" : "ghost"}`} onClick={() => setFps(f)}>{f}fps</button>
                ))}
              </div>
              <div className="hint">
                {scanMs != null && `Scan took ${(scanMs / 1000).toFixed(1)}s. `}
                One frame step is {frameMs.toFixed(1)} ms, which is the floor on this clip. The turn is
                never auto-placed: at the far wall the swimmer is smaller than the sparkle on the water.
                <label className="file" style={{ padding: "10px 16px", fontSize: 13, marginTop: 14 }}>
                  Load a different video<input type="file" accept="video/*" onChange={pickFile} />
                </label>
              </div>
            </>
          )}
        </>
      )}

      <div style={{ marginTop: 24 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Saved swims {swims.length ? `· ${swims.length}` : ""}</div>
        {swims.length === 0 ? (
          <div className="hint">Nothing saved yet. Scan a clip, confirm the two marks, then save.</div>
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
