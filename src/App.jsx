import React, { useState, useRef, useEffect, useCallback } from "react";

const FPS_OPTIONS = [24, 25, 30, 50, 60, 120, 240];
const SPEEDS = [1, 0.5, 0.25, 0.1];
const ZOOMS = [1, 2, 3];
const COURSES = [
  { id: "50m", label: "50 m", metres: 50 },
  { id: "100m", label: "100 m", metres: 100 },
  { id: "50y", label: "50 y", metres: 45.72 },
  { id: "100y", label: "100 y", metres: 91.44 },
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* window.storage in Claude artifacts, localStorage anywhere else */
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
      /* in-memory only for this session */
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

  const [trace, setTrace] = useState(null); // [{t, v}]
  const [scanning, setScanning] = useState(false);
  const [scanPct, setScanPct] = useState(0);
  const [note, setNote] = useState(null);

  const [course, setCourse] = useState("50m");
  const [swims, setSwims] = useState([]);
  const [flash, setFlash] = useState(0);

  /* ---------- saved swims ---------- */
  useEffect(() => {
    let alive = true;
    store.get("swims:log").then((v) => {
      if (!alive || !v) return;
      try {
        setSwims(JSON.parse(v));
      } catch {
        /* corrupt entry, start fresh */
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

  /* ---------- playhead ---------- */
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

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  /* ---------- file ---------- */
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
    setTrace(null);
    setCurrent(0);
    setPlaying(false);
    setDecodeError(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNote(null);
    e.target.value = "";
  };

  const onMeta = (e) => {
    const v = e.currentTarget;
    const d = v.duration;
    setDuration(isFinite(d) ? d : 0);
    setPortrait(v.videoHeight > v.videoWidth);
    if (!v.videoWidth) setDecodeError(true);
  };

  /* ---------- transport ---------- */
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
    // snap to the frame the browser actually shows, not the arithmetic guess
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((now, meta) => setCurrent(meta.mediaTime));
    } else {
      setCurrent(target);
    }
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

  const playSwim = () => {
    const v = videoRef.current;
    if (!v || dive == null) return;
    seekTo(Math.max(0, dive - 0.4));
    v.playbackRate = speed;
    v.play().catch(() => {});
    setPlaying(true);
  };

  const mark = (which) => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    ({ dive: setDive, turn: setTurn, touch: setTouch })[which](t);
    setFlash((n) => n + 1);
  };

  /* ---------- motion scan ---------- */
  /* Plays the clip fast and muted, sampling every presented frame into a small
     canvas. Frame-to-frame difference gives a trace of how much the water moved. */
  const runScan = async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !duration) return;
    if (!v.requestVideoFrameCallback) {
      setNote("This browser can't sample video frames. Mark the swim by hand instead.");
      return;
    }
    setScanning(true);
    setScanPct(0);
    setNote(null);
    pause();

    const W = 48;
    const H = Math.max(24, Math.round(W * (v.videoHeight / v.videoWidth || 1.5)));
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const samples = [];
    let prev = null;

    v.currentTime = 0;
    v.muted = true;
    v.playbackRate = 4;

    await new Promise((done) => {
      const onFrame = (now, meta) => {
        ctx.drawImage(v, 0, 0, W, H);
        const px = ctx.getImageData(0, 0, W, H).data;
        const gray = new Float32Array(W * H);
        for (let i = 0, j = 0; i < px.length; i += 4, j++)
          gray[j] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        if (prev) {
          let sum = 0;
          for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prev[i]);
          samples.push({ t: meta.mediaTime, v: sum / gray.length });
        }
        prev = gray;
        setScanPct(clamp(meta.mediaTime / duration, 0, 1));
        if (v.ended || meta.mediaTime >= duration - 0.05) return done();
        v.requestVideoFrameCallback(onFrame);
      };
      v.play().then(
        () => v.requestVideoFrameCallback(onFrame),
        () => done()
      );
      setTimeout(done, Math.min(60000, (duration / 4) * 1000 + 8000));
    });

    v.pause();
    v.playbackRate = speed;
    setPlaying(false);
    setScanning(false);
    setScanPct(0);

    if (samples.length < 10) {
      setNote("Couldn't read enough frames to build a trace. Mark it by hand.");
      return;
    }
    setTrace(samples);

    // dive = loudest frame of the first burst of movement, not the first frame
    // that crosses the line — that one catches the wind-up on the deck
    const vals = samples.map((s) => s.v).slice().sort((a, b) => a - b);
    const base = vals[Math.floor(vals.length / 2)];
    const thr = base + (vals[vals.length - 1] - base) * 0.35;
    let start = -1;
    let end = -1;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].v <= thr) continue;
      if (start < 0) { start = i; end = i; }
      else if (samples[i].t - samples[end].t < 0.4) end = i;
      else break;
    }
    if (start < 0) {
      setNote("No clear entry splash. Mark the dive by hand.");
      return;
    }
    let best = start;
    for (let j = start; j <= end; j++) if (samples[j].v > samples[best].v) best = j;
    setDive(samples[best].t);
    seekTo(samples[best].t);
    setFlash((n) => n + 1);
    setNote("Dive placed at the biggest jump in the first splash. Check it at 0.1× before you trust it.");
  };

  const jumpToPeakNear = (t, window_ = 0.6) => {
    if (!trace) return;
    const near = trace.filter((s) => Math.abs(s.t - t) < window_);
    if (!near.length) return;
    const best = near.reduce((a, b) => (b.v > a.v ? b : a));
    seekTo(best.t);
  };

  /* ---------- rail ---------- */
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

  /* ---------- pan ---------- */
  const onStageDown = (e) => {
    panRef.current = { dragging: true, moved: false, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onStageMove = (e) => {
    const p = panRef.current;
    if (!p.dragging || zoom === 1) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) p.moved = true;
    p.x = e.clientX;
    p.y = e.clientY;
    const lim = (zoom - 1) * 50;
    setPan((o) => ({ x: clamp(o.x + dx / 3, -lim, lim), y: clamp(o.y + dy / 3, -lim, lim) }));
  };
  const onStageUp = () => {
    const p = panRef.current;
    if (!p.moved) togglePlay();
    p.dragging = false;
  };

  /* ---------- results ---------- */
  const valid = dive != null && touch != null && touch > dive;
  const total = valid ? touch - dive : null;
  const lap1 = valid && turn != null && turn > dive && turn < touch ? turn - dive : null;
  const lap2 = lap1 != null ? total - lap1 : null;
  const metres = COURSES.find((c) => c.id === course).metres;
  const pace100 = total ? (total / metres) * 100 : null;
  const bestTime = swims.length ? Math.min(...swims.map((s) => s.total)) : null;

  const saveSwim = () => {
    if (!valid) return;
    persist(
      [
        { id: Date.now(), total, lap1, lap2, course, when: new Date().toISOString(), file: fileName || "clip" },
        ...swims,
      ].slice(0, 40)
    );
  };

  const pct = (t) => (duration ? clamp((t / duration) * 100, 0, 100) : 0);

  const tracePath = () => {
    if (!trace || !duration) return "";
    const max = Math.max(...trace.map((s) => s.v)) || 1;
    const pts = trace.map((s) => `${(s.t / duration) * 100},${26 - (s.v / max) * 24}`);
    return `M0,26 L${pts.join(" L")} L100,26 Z`;
  };

  const MARKS = [
    { key: "dive", label: "Dive in", sub: "feet leave the deck", val: dive, set: setDive, c: "var(--water)" },
    { key: "turn", label: "Turn", sub: "optional, splits the lengths", val: turn, set: setTurn, c: "var(--amber)" },
    { key: "touch", label: "Touch", sub: "hand hits the wall", val: touch, set: setTouch, c: "var(--pennant)" },
  ];

  return (
    <div className="pool">
      <style>{`
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;800&family=Martian+Mono:wght@400;600;700&display=swap');
.pool{--ink:#07141A;--deck:#0E2029;--panel:#122B36;--line:#1E4453;--text:#E6F4F7;--muted:#7DA3B1;
  --water:#2FD4E4;--amber:#FFB454;--pennant:#FF5C63;
  min-height:100vh;background:radial-gradient(120% 80% at 50% -10%,#123543 0%,var(--ink) 62%);
  color:var(--text);font-family:'Archivo',ui-sans-serif,system-ui,sans-serif;padding:18px 14px 44px;box-sizing:border-box}
.pool *{box-sizing:border-box}
.mono{font-family:'Martian Mono',ui-monospace,SFMono-Regular,monospace;font-variant-numeric:tabular-nums}
.eyebrow{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);font-weight:600}
.board{border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,#0F2632,#0A1D26);
  padding:16px;margin:12px 0 14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.clock{font-size:clamp(46px,17vw,76px);line-height:.92;font-weight:700;letter-spacing:-.03em;display:block;margin:6px 0 2px}
.clock.dim{color:#2E5364}
.clock.hit{animation:pop .35s ease-out}
@keyframes pop{0%{transform:scale(1.035);color:var(--water)}100%{transform:scale(1)}}
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
.mark::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c)}
.mark .who{flex:1;min-width:0}
.mark .who b{display:block;font-size:14px}
.mark .who span{font-size:11.5px;color:var(--muted)}
.mini{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:9px 10px;
  font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;flex:none}
.mini.set{background:var(--c);border-color:var(--c);color:#04171C}
.note{background:var(--deck);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:10px;
  padding:11px 13px;font-size:12.5px;color:var(--text);line-height:1.5;margin-top:12px}
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
            Choose video
            <input type="file" accept="video/*" onChange={pickFile} />
          </label>
          <p className="hint">
            Shoot from the side of the pool if you can. Filming down the lane from behind the block
            hides the touch behind the splash.
          </p>
        </div>
      ) : (
        <>
          <div className="board">
            <div className="eyebrow">Total</div>
            <span key={flash} className={`mono clock ${total ? "hit" : "dim"}`}>{clockText(total)}</span>
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
              <p>
                iPhone clips are HEVC, which Safari plays and most other browsers don't. In Photos,
                share the video and choose Most Compatible, or set Camera to High Efficiency off.
              </p>
              <label className="file">Try another video<input type="file" accept="video/*" onChange={pickFile} /></label>
            </div>
          ) : (
            <>
              <div
                className="stage"
                onPointerDown={onStageDown}
                onPointerMove={onStageMove}
                onPointerUp={onStageUp}
                style={{ maxHeight: portrait ? "58vh" : "42vh" }}
              >
                <video
                  ref={videoRef}
                  src={src}
                  playsInline
                  preload="auto"
                  onLoadedMetadata={onMeta}
                  onError={() => setDecodeError(true)}
                  onSeeked={(e) => setCurrent(e.currentTarget.currentTime)}
                  onPause={() => setPlaying(false)}
                  onPlay={() => setPlaying(true)}
                  style={{
                    maxHeight: portrait ? "58vh" : "42vh",
                    width: portrait ? "auto" : "100%",
                    transform: `scale(${zoom}) translate(${pan.x}px,${pan.y}px)`,
                  }}
                />
                <div className="badge mono">{current.toFixed(2)}s</div>
                {scanning && <div className="scanbar" style={{ width: `${scanPct * 100}%` }} />}
              </div>

              <div
                className="rail"
                ref={railRef}
                role="slider"
                tabIndex={0}
                aria-label="Video position"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration * 100) / 100 || 0}
                aria-valuenow={Math.round(current * 100) / 100}
                onPointerDown={onRailDown}
                onPointerMove={onRailMove}
                onKeyDown={onRailKey}
              >
                {trace && (
                  <svg className="trace" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                    <path d={tracePath()} fill="rgba(47,212,228,.28)" stroke="var(--water)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
                  </svg>
                )}
                <div className="cord" />
                {valid && <div className="span" style={{ left: `${pct(dive)}%`, width: `${pct(touch) - pct(dive)}%` }} />}
                {MARKS.filter((m) => m.val != null).map((m) => (
                  <div className="flag" key={m.key} style={{ left: `${pct(m.val)}%` }}>
                    <u style={{ background: m.c }} />
                    <i style={{ background: m.c }} />
                  </div>
                ))}
                <div className="head" style={{ left: `${pct(current)}%` }} />
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
                    {z === 1 ? "fit" : `${z}×zoom`}
                  </button>
                ))}
              </div>

              <div className="row">
                <button className="btn" onClick={runScan} disabled={scanning}>
                  {scanning ? `Reading the water… ${Math.round(scanPct * 100)}%` : trace ? "Scan again" : "Scan the clip"}
                </button>
              </div>

              {note && <div className="note">{note}</div>}

              <div className="marks">
                {MARKS.map((m) => (
                  <div className="mark" key={m.key} style={{ "--c": m.c }}>
                    <div className="who">
                      <b>{m.label}</b>
                      <span className="mono">{m.val != null ? `${m.val.toFixed(2)}s` : "not set"} — {m.sub}</span>
                    </div>
                    {m.val != null && (
                      <>
                        <button className="mini" onClick={() => seekTo(m.val)}>Go</button>
                        {trace && <button className="mini" onClick={() => jumpToPeakNear(m.val)}>Snap</button>}
                        <button className="mini" onClick={() => m.set(null)}>Clear</button>
                      </>
                    )}
                    <button className="mini set" style={{ "--c": m.c }} onClick={() => mark(m.key)}>Mark</button>
                  </div>
                ))}
              </div>

              <div className="row">
                <button className="btn" onClick={playSwim} disabled={dive == null}>Play the swim</button>
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
                One frame step is {(1000 / fps).toFixed(1)} ms, which is the finest this clip can
                resolve. At 30 fps your time is only ever good to about a third of a tenth — shoot in
                slo-mo at 120 or 240 if you want the touch to be honest.
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
          <div className="hint">Nothing saved yet. Mark a dive and a touch, then save to build a log you can race against.</div>
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
