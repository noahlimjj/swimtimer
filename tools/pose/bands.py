#!/usr/bin/env python3
"""Diagnostic: does a motion signal for dive / turn / touch exist in any
horizontal slice of the water?  Splits the water ROI into vertical bands and
prints per-band motion energy over time, so we can see where (if anywhere) each
event shows up before committing to a waterline fit.

Usage: python3 tools/pose/bands.py <clip.mov> <dive> <turn|-> <touch|->
"""
import subprocess, sys
import numpy as np

W, H = 480, 854
CAM_FRAC, CAM_MARGIN = 0.25, 0.45
NB = 8            # number of horizontal bands
NX = 3           # number of horizontal (x) columns


def dec(p):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-vf",
                        f"scale={W}:{H},format=gray", "-f", "rawvideo",
                        "-pix_fmt", "gray", "-"], capture_output=True)
    a = np.frombuffer(r.stdout, np.uint8)
    n = a.size // (W * H)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=duration", "-of",
                                "csv=p=0", p], capture_output=True, text=True).stdout.strip().rstrip(","))
    return a[:n * W * H].reshape(n, H, W).astype(np.float32), dur


def main():
    p = sys.argv[1]
    gt = [None if x == "-" else float(x) for x in sys.argv[2:5]]
    f, dur = dec(p)
    n = len(f)
    fps = (n - 1) / dur
    D = np.zeros_like(f); D[1:] = np.abs(np.diff(f, axis=0))

    cell = f.reshape(n, H, W)
    g = 20
    cg = f[:, :H // g * g, :W // g * g].reshape(n, H // g, g, W // g, g).mean(axis=(2, 4))
    cd = np.zeros_like(cg); cd[1:] = np.abs(np.diff(cg, axis=0))
    frac = (cd > 12).mean(axis=(1, 2))
    steady = frac <= CAM_FRAC
    kk = max(1, int(CAM_MARGIN * fps))
    bad = np.convolve((~steady).astype(float), np.ones(2 * kk + 1), "same") > 0
    stable = ~bad
    idx = np.where(stable)[0]

    var = f[idx].var(axis=0)
    roi = var > np.percentile(var, 70)

    print(f"# {p.split('/')[-1]} fps={fps:.3f} n={n} dur={dur:.2f} "
          f"steady={sum(stable)}/{n}  GT dive={gt[0]} turn={gt[1]} touch={gt[2]}")
    ys = np.linspace(0, H, NB + 1).astype(int)
    xs = np.linspace(0, W, NX + 1).astype(int)
    # energy[band, xcol, frame]
    E = np.zeros((NB, NX, n))
    for bi in range(NB):
        for xi in range(NX):
            m = np.zeros((H, W), bool)
            m[ys[bi]:ys[bi + 1], xs[xi]:xs[xi + 1]] = roi[ys[bi]:ys[bi + 1], xs[xi]:xs[xi + 1]]
            if m.sum() < 30:
                continue
            E[bi, xi] = (D * m[None]).sum(axis=(1, 2)) / m.sum()

    # smooth
    k = 5
    for bi in range(NB):
        for xi in range(NX):
            E[bi, xi] = np.convolve(E[bi, xi], np.ones(k) / k, "same")

    def frames_near(tsec, half=0.6):
        if tsec is None:
            return []
        c = int(tsec * fps)
        return list(range(max(0, c - int(half * fps)), min(n, c + int(half * fps))))

    labels = ["dive", "turn", "touch"]
    for li, ts in enumerate(gt):
        if ts is None:
            continue
        fr = frames_near(ts, 1.0)
        print(f"\n## {labels[li]} @ {ts:.2f}s  (frame {int(ts*fps)})")
        print("   band(y range)      x0        x1        x2      | peak frame near GT")
        for bi in range(NB):
            row = f"   b{bi} y{ys[bi]:>4}-{ys[bi+1]:<4}  "
            for xi in range(NX):
                seg = E[bi, xi][fr]
                base = np.percentile(E[bi, xi][stable], 20)
                pk = seg.max() - base if len(seg) else 0
                row += f"{pk:8.2f}  "
            # where in the window is the peak for the loudest xcol
            row += "|"
            for xi in range(NX):
                seg = E[bi, xi][fr]
                if len(seg):
                    row += f" x{xi}:{fr[int(np.argmax(seg))]}"
            print(row)

    # global: for each band/xcol, the single loudest frame over the whole clip
    print("\n## loudest frame per band/xcol over whole clip (stable only)")
    for bi in range(NB):
        row = f"   b{bi} y{ys[bi]:>4}-{ys[bi+1]:<4}  "
        for xi in range(NX):
            e = E[bi, xi].copy()
            e[~stable] = -1
            fmax = int(np.argmax(e))
            row += f" x{xi}: f{fmax} ({fmax/fps:5.2f}s v={e[fmax]:.2f})  "
        print(row)


main()
