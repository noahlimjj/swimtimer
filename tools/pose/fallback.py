#!/usr/bin/env python3
"""Classical-CV fallback for swim-event detection.

Idea (see task step 5): frame-to-frame motion energy measured over the whole
water fails because splash loudness tracks camera distance, not swimmer
position, and a full-width horizontal band catches on-deck prep. So instead:

  1. camera-handling gate  (share of changed cells > 0.25  ->  phone moved)
  2. temporal-median frame over the steady window (still water -> clean edges)
  3. Sobel edge map of the median frame; robustly fit the near waterline
     (the strong deck/water boundary in the lower half) as a line
  4. measure motion energy in a NARROW band hugging that fitted line only
     -- this excludes the deck and the open water sparkle
  5. read rises off that band-energy signal

Also fits a second band along the far waterline for a turn attempt.

numpy only; frames are streamed from ffmpeg as raw gray.
Usage: python3 tools/pose/fallback.py <clip.mov> [--gt dive,turn,touch]
"""
import subprocess, sys, json
import numpy as np

W, H = 480, 854            # analysis resolution (matches extracted frames)
CAM_FRAC = 0.25
CAM_MARGIN = 0.45
CELL = 20                  # gate grid cell size in px


def probe(path):
    q = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=duration,nb_frames", "-of", "json", path]
    d = json.loads(subprocess.run(q, capture_output=True, text=True).stdout)
    s = d["streams"][0]
    return float(s["duration"]), int(s.get("nb_frames", 0))


def decode_gray(path):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H},format=gray",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
    a = np.frombuffer(p.stdout, np.uint8)
    n = a.size // (W * H)
    return a[:n * W * H].reshape(n, H, W).astype(np.float32)


def sobel(img):
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], np.float32)
    ky = kx.T
    def conv(a, k):
        from numpy.lib.stride_tricks import sliding_window_view
        pad = np.pad(a, 1, mode="edge")
        win = sliding_window_view(pad, (3, 3))
        return np.einsum("ijkl,kl->ij", win, k)
    gx = conv(img, kx); gy = conv(img, ky)
    return np.hypot(gx, gy), gy


def fit_waterline(edge, gy, y_lo, y_hi):
    """Per-column, pick the row of maximum |gradient| within [y_lo,y_hi] that is
    a dark->light or light->dark horizontal transition; robustly fit y = a*x + b
    with an IRLS / Theil-sen-ish median fit."""
    cols = np.arange(W)
    band = edge[y_lo:y_hi, :]
    rows = np.argmax(band, axis=0) + y_lo
    strength = band.max(axis=0)
    good = strength > np.percentile(strength, 55)
    xs, ys = cols[good], rows[good]
    if len(xs) < 20:
        return None
    # Theil-Sen slope
    idx = np.random.default_rng(0).choice(len(xs), size=min(4000, len(xs) * (len(xs) - 1) // 2 or 1), replace=True)
    slopes = []
    rng = np.random.default_rng(1)
    for _ in range(2000):
        i, j = rng.integers(0, len(xs), 2)
        if xs[i] == xs[j]:
            continue
        slopes.append((ys[i] - ys[j]) / (xs[i] - xs[j]))
    a = np.median(slopes)
    b = np.median(ys - a * xs)
    # one reweighted pass to reject outliers (trees, ladders)
    resid = np.abs(ys - (a * xs + b))
    keep = resid < 2.5 * np.median(resid) + 5
    if keep.sum() > 20:
        A = np.polyfit(xs[keep], ys[keep], 1)
        a, b = A[0], A[1]
    return float(a), float(b)


def band_mask(a, b, half):
    yy, xx = np.mgrid[0:H, 0:W]
    line_y = a * xx + b
    return (np.abs(yy - line_y) <= half)


def energy_in(diffs, mask):
    m = mask[None, :, :]
    s = (diffs * m).sum(axis=(1, 2)) / max(1, mask.sum())
    return s


def rises(e, t, stable, k_smooth=5):
    e = np.convolve(e, np.ones(k_smooth) / k_smooth, "same")
    es = e[stable]
    base = np.percentile(es, 15)
    hi = np.percentile(es, 97)
    thr = base + 0.30 * (hi - base)
    active = (e > thr) & stable
    out = []
    i = 0
    while i < len(active):
        if active[i]:
            j = i
            while j + 1 < len(active) and (active[j + 1] or not stable[j + 1]):
                j += 1
            # walk back the leading edge to where the rise began
            foot = base + 0.5 * (e[i:j + 1].max() - base)
            s = i
            while s > 0 and e[s - 1] > foot:
                s -= 1
            out.append((s, i, j, float(e[i:j + 1].max())))
            i = j + 1
        else:
            i += 1
    return e, thr, base, out


def analyse(path, gt=None):
    dur, nbf = probe(path)
    f = decode_gray(path)
    n = len(f)
    fps = (n - 1) / dur
    t = np.arange(n) / fps
    D = np.zeros_like(f)
    D[1:] = np.abs(np.diff(f, axis=0))

    # 1. camera gate
    gh, gw = H // CELL, W // CELL
    cg = f[:, :gh * CELL, :gw * CELL].reshape(n, gh, CELL, gw, CELL).mean(axis=(2, 4))
    cd = np.zeros_like(cg); cd[1:] = np.abs(np.diff(cg, axis=0))
    frac = (cd > 12).mean(axis=(1, 2))
    steady = frac <= CAM_FRAC
    kk = max(1, int(CAM_MARGIN * fps))
    bad = ~steady
    bad = np.convolve(bad.astype(float), np.ones(2 * kk + 1), "same") > 0
    stable = ~bad
    idx = np.where(stable)[0]
    if len(idx) < fps * 2:
        return dict(error="camera moves for most of the clip", fps=fps, n=n)

    med = np.median(f[idx[:: max(1, len(idx) // 200)]], axis=0)
    edge, gy = sobel(med)

    # 3. near waterline: strong boundary in the lower-middle of the frame
    near = fit_waterline(edge, gy, int(H * 0.45), int(H * 0.80))
    far = fit_waterline(edge, gy, int(H * 0.33), int(H * 0.48))

    res = dict(fps=fps, n=n, dur=dur, stable=(float(t[idx[0]]), float(t[idx[-1]])),
               near_line=near, far_line=far)

    for tag, ln, half in (("near", near, 9), ("far", far, 5)):
        if ln is None:
            res[tag] = dict(error="no line fitted")
            continue
        a, b = ln
        mask = band_mask(a, b, half)
        # keep only the water side is hard without geometry; use the whole band
        e = energy_in(D, mask)
        esm, thr, base, runs = rises(e, t, stable)
        cand = []
        for (s, i, j, pk) in runs:
            if (j - i) / fps < 0.15:
                continue
            cand.append(dict(rise_t=float(t[s]), peak_v=pk,
                             span=(float(t[i]), float(t[j]))))
        cand.sort(key=lambda c: -c["peak_v"])
        res[tag] = dict(line=(a, b), mask_px=int(mask.sum()),
                        base=float(base), thr=float(thr),
                        candidates=cand[:6],
                        trace=[float(x) for x in esm[:: max(1, n // 400)]])
    if gt:
        res["gt"] = gt
    return res


def fmt(path, gt):
    r = analyse(path, gt)
    name = path.split("/")[-1]
    print(f"=== {name}  fps={r['fps']:.3f} n={r['n']} dur={r.get('dur',0):.2f}")
    if "error" in r:
        print("  ERROR", r["error"]); return
    print(f"  camera steady {r['stable'][0]:.2f}-{r['stable'][1]:.2f}s")
    for tag in ("near", "far"):
        d = r[tag]
        if "error" in d:
            print(f"  {tag}: {d['error']}"); continue
        a, b = d["line"]
        print(f"  {tag} waterline  y = {a:+.3f}x + {b:.1f}   band={d['mask_px']}px  "
              f"base={d['base']:.2f} thr={d['thr']:.2f}")
        for c in d["candidates"]:
            print(f"      rise @ {c['rise_t']:6.2f}s  peak_v={c['peak_v']:.2f}  "
                  f"span {c['span'][0]:.2f}-{c['span'][1]:.2f}")
    if gt:
        g = dict(zip(("dive", "turn", "touch"), gt))
        print("  GT:", ", ".join(f"{k}={v}" for k, v in g.items() if v is not None))


if __name__ == "__main__":
    path = sys.argv[1]
    gt = None
    if "--gt" in sys.argv:
        raw = sys.argv[sys.argv.index("--gt") + 1].split(",")
        gt = [float(x) if x not in ("", "-") else None for x in raw]
    fmt(path, gt)
