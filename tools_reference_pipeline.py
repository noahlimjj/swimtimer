#!/usr/bin/env python3
"""Automatic two-length swim timing. Reference implementation of the pipeline
that ships in the app, kept in Python so it can be validated against clips with
known answers.

Stages, in order, each one fixing a failure seen on real footage:

1. Decode once, small and grey. Everything downstream reuses the same array.
2. Gate out camera handling. The top band of the frame is sky and trees; it only
   changes when the phone is picked up or set down. Those frames are excluded,
   with a margin, before anything else is measured. Without this the loudest
   event in a clip is someone grabbing the phone.
3. Find the water. Pixels with high temporal variance across the stable frames
   are the pool; the deck and sky are not. All motion is measured inside it.
4. Find the swim. Threshold water motion, group into runs, and take the longest.
   A swimmer walking into frame makes a huge, short burst that gets rejected
   because it does not sustain.
5. Dive. The entry splash is the first sharp peak inside the run. Takeoff is
   walked back from that peak to where the rise begins.
6. Trajectory. The centroid of loud motion, projected onto the pool's long axis,
   gives position over time: out, turn, back.
7. Turn and touch from that trajectory rather than from raw motion, because at
   the far wall the swimmer is too small to spike and at the near wall the touch
   is buried under whitewater.
"""
import json, subprocess, sys
import numpy as np

TOP_BAND = 0.22        # sky/trees, used as the camera-motion witness
CAM_MARGIN = 0.45      # seconds of margin around any handled frame
GRID_W = 96


def probe(path):
    q = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-print_format",
         "json", "-show_streams", "-show_format", path]
    d = json.loads(subprocess.run(q, capture_output=True, text=True).stdout)
    s = d["streams"][0]
    rot = 0
    for sd in s.get("side_data_list", []):
        rot = sd.get("rotation", rot)
    w, h = int(s["width"]), int(s["height"])
    if abs(rot) == 90:
        w, h = h, w
    return dict(w=w, h=h, dur=float(d["format"]["duration"]),
                codec=s["codec_name"], rot=rot,
                hdr=s.get("color_transfer", ""), pix=s.get("pix_fmt", ""))


def decode(path, meta):
    h = max(24, round(GRID_W * meta["h"] / meta["w"]))
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf",
         f"scale={GRID_W}:{h},format=gray", "-f", "rawvideo", "-pix_fmt",
         "gray", "-"], capture_output=True)
    a = np.frombuffer(p.stdout, dtype=np.uint8)
    n = a.size // (GRID_W * h)
    return a[: n * GRID_W * h].reshape(n, h, GRID_W).astype(np.float32), h


def analyse(path):
    meta = probe(path)
    f, H = decode(path, meta)
    n = len(f)
    fps = (n - 1) / meta["dur"]
    D = np.abs(np.diff(f, axis=0))          # n-1 difference frames
    t = (np.arange(n - 1) + 1) / fps
    out = dict(meta=meta, fps=fps, frames=n)

    # --- 2. camera-handling gate -------------------------------------------
    top = D[:, : int(H * TOP_BAND), :].mean(axis=(1, 2))
    med = np.median(top)
    mad = np.median(np.abs(top - med)) + 1e-6
    handled = top > med + 12 * mad
    k = max(1, int(CAM_MARGIN * fps))
    handled = np.convolve(handled.astype(float), np.ones(2 * k + 1), "same") > 0
    stable = ~handled
    out["stable_span"] = (float(t[stable][0]), float(t[stable][-1])) if stable.any() else None
    if stable.sum() < fps * 2:
        return {**out, "error": "camera moves for almost the whole clip"}

    # --- 3. water ROI ------------------------------------------------------
    idx = np.where(stable)[0]
    var = f[idx].var(axis=0)
    roi = var > np.percentile(var, 60)
    roi[: int(H * TOP_BAND), :] = False     # never count sky as water
    if roi.sum() < 40:
        roi = var > np.percentile(var, 40)
    out["roi_frac"] = float(roi.mean())

    # --- 4. the swim -------------------------------------------------------
    e = (D * roi).sum(axis=(1, 2)) / roi.sum()
    e_stable = e[stable]
    base = float(np.median(e_stable))
    hi = float(np.percentile(e_stable, 99.5))
    thr = base + 0.22 * (hi - base)
    active = (e > thr) & stable

    runs, cur = [], None
    gap = int(0.5 * fps)
    for i, a in enumerate(active):
        if a:
            if cur is None:
                cur = [i, i]
            else:
                cur[1] = i
        elif cur is not None and i - cur[1] > gap:
            runs.append(tuple(cur)); cur = None
    if cur is not None:
        runs.append(tuple(cur))
    runs = [r for r in runs if (r[1] - r[0]) / fps > 1.5]
    if not runs:
        return {**out, "error": "no sustained water disturbance found"}
    s0, s1 = max(runs, key=lambda r: r[1] - r[0])
    out["swim_window"] = (float(t[s0]), float(t[s1]))

    # --- 5. dive -----------------------------------------------------------
    look = slice(s0, min(s0 + int(2.0 * fps), s1))
    seg = e[look]
    pk = s0 + int(np.argmax(seg))
    floor_ = base + 0.15 * (e[pk] - base)
    j = pk
    while j > s0 and e[j - 1] > floor_:
        j -= 1
    out["dive"] = float(t[j])
    out["dive_peak"] = float(t[pk])

    # --- 6. trajectory -----------------------------------------------------
    ys, xs = np.nonzero(roi)
    pts = np.stack([xs, ys]).astype(np.float32)
    pts -= pts.mean(axis=1, keepdims=True)
    axis = np.linalg.svd(pts, full_matrices=False)[0][:, 0]     # pool long axis
    gx, gy = np.meshgrid(np.arange(GRID_W), np.arange(H))
    proj = gx * axis[0] + gy * axis[1]
    near = proj[roi].max() if (proj[roi] * 1).mean() else 0

    s_of_t, w_of_t = [], []
    for i in range(s0, s1 + 1):
        m = D[i] * roi
        cut = m.max() * 0.45
        m = np.where(m > cut, m, 0)
        w = m.sum()
        if w < 1e-3:
            s_of_t.append(np.nan); w_of_t.append(0.0); continue
        s_of_t.append(float((m * proj).sum() / w))
        w_of_t.append(float(w))
    s_arr = np.array(s_of_t)
    # fill gaps, then smooth over ~0.4 s
    ok = ~np.isnan(s_arr)
    if ok.sum() < 5:
        return {**out, "error": "could not track the swimmer"}
    s_arr = np.interp(np.arange(len(s_arr)), np.where(ok)[0], s_arr[ok])
    win = max(3, int(0.4 * fps) | 1)
    kern = np.ones(win) / win
    s_sm = np.convolve(np.pad(s_arr, win // 2, mode="edge"), kern, "valid")[: len(s_arr)]
    tt = t[s0 : s1 + 1]

    # orient the axis so that larger = nearer the camera (where the dive is)
    start_val = s_sm[: max(3, int(0.4 * fps))].mean()
    if start_val < s_sm.mean():
        s_sm = -s_sm
    out["axis"] = [float(axis[0]), float(axis[1])]

    # --- 7. turn and touch -------------------------------------------------
    d_i = int((out["dive"] - tt[0]) * fps)
    d_i = max(0, min(d_i, len(s_sm) - 1))
    far_rel = int(np.argmin(s_sm[d_i:])) + d_i        # furthest point reached
    out["turn"] = float(tt[far_rel])

    back = s_sm[far_rel:]
    if len(back) > 3:
        peak_rel = int(np.argmax(back)) + far_rel
        # touch = first frame within one grid cell of the nearest point reached
        target = s_sm[peak_rel] - 1.0
        cand = np.where(s_sm[far_rel : peak_rel + 1] >= target)[0]
        touch_rel = (cand[0] + far_rel) if len(cand) else peak_rel
        out["touch"] = float(tt[touch_rel])
        out["touch_settle"] = float(tt[peak_rel])
    out["e_base"], out["e_thr"] = base, thr
    return out


def report(path):
    r = analyse(path)
    m = r["meta"]
    print(f"CLIP  {path.split('/')[-1]}")
    print(f"  {m['w']}x{m['h']} {r['fps']:.2f} fps {m['dur']:.2f}s {m['codec']} "
          f"rot={m['rot']}  ({r['frames']} frames)")
    if r.get("stable_span"):
        print(f"  camera steady {r['stable_span'][0]:.2f}–{r['stable_span'][1]:.2f}s")
    if "error" in r:
        print("  UNREADABLE:", r["error"]); return r
    print(f"  water ROI {r['roi_frac']*100:.0f}% of frame, "
          f"swim window {r['swim_window'][0]:.2f}–{r['swim_window'][1]:.2f}s")
    print(f"  DIVE  {r['dive']:.3f}s   (entry splash peak {r['dive_peak']:.3f})")
    print(f"  TURN  {r['turn']:.3f}s")
    if "touch" in r:
        print(f"  TOUCH {r['touch']:.3f}s  (settles {r['touch_settle']:.3f})")
        tot = r["touch"] - r["dive"]
        print(f"  TOTAL {tot:.2f}s   L1 {r['turn']-r['dive']:.2f}  "
              f"L2 {r['touch']-r['turn']:.2f}")
    return r


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p); print()
