#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   score.mjs — offline scoring harness for the swim-timing detector.

   Loads every fixture in test/fixtures/, runs a detector on each, and prints a
   table of error against hand-marked ground truth.

   Two detector shapes are supported:

   1. BASELINE (default): src/detect.js. It returns ranked `candidates` and does
      NOT name a dive or a touch. For each ground-truth event we pick the CLOSEST
      candidate `t` and report that gap. This measures "is the right moment even
      in the candidate list", not "does the detector call it".

   2. PLUGGABLE: `--detector <path>` to an ES module whose default export is
        (samples, fps) => ({ dive, turn, touch, uncertainty, notes })
      Scored as a real detector: dive PASS within +/-2 frames, touch within
      +/-3, turn within +/-5 (pass/fail, turn ground truth is not recorded so
      turn is reported but never gated).

   1 frame = 1/30 s ~= 33.3 ms (times are only ever good to a frame).

   Usage:
     node tools/score.mjs
     node tools/score.mjs --detector ./tools/my-detector.mjs
   --------------------------------------------------------------------------- */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { detect } from "../src/detect.js";
import { listFixtures, loadFixture } from "./fixture-io.mjs";

const FRAME = 1 / 30;

// Hand-marked, frame-by-frame. `null` = event not in clip.
const GROUND_TRUTH = {
  IMG_7199: { dive: 1.05, touch: null },
  IMG_7464: { dive: 12.75, touch: 25.85 },
  IMG_7465: { dive: 2.234, touch: 15.2 },
  IMG_7466: { dive: 12.5, touch: 25.52 },
};

const f2 = (x) => (x == null ? "  -  " : x.toFixed(2));
const f3 = (x) => (x == null ? "   -   " : x.toFixed(3));
const frames = (dt) => (dt == null ? "  -  " : (dt / FRAME).toFixed(1));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function getDetectorArg() {
  const i = process.argv.indexOf("--detector");
  if (i === -1) return null;
  const p = process.argv[i + 1];
  if (!p) {
    console.error("--detector needs a path");
    process.exit(1);
  }
  return resolve(p);
}

function closest(cands, target) {
  if (target == null || !cands.length) return null;
  let best = null;
  for (const c of cands) {
    const d = Math.abs(c.t - target);
    if (!best || d < best.d) best = { c, d };
  }
  return best.c;
}

async function main() {
  const names = listFixtures();
  if (!names.length) {
    console.error(
      "No fixtures in test/fixtures/. Run:  npm run extract-fixtures"
    );
    process.exit(1);
  }

  const detectorPath = getDetectorArg();
  const custom = detectorPath
    ? (await import(pathToFileURL(detectorPath).href)).default
    : null;

  if (custom) {
    console.log(`\nDETECTOR  ${detectorPath}\n`);
    console.log(
      pad("clip", 12),
      padL("dive gt", 9),
      padL("dive", 8),
      padL("d err(fr)", 10),
      padL("touch gt", 9),
      padL("touch", 8),
      padL("t err(fr)", 10),
      padL("turn", 8),
      padL("uncert", 8),
      "result"
    );
    for (const name of names) {
      const gt = GROUND_TRUTH[name] || { dive: null, touch: null };
      const { samples, fps } = loadFixture(name);
      let r;
      try {
        r = custom(samples, fps) || {};
      } catch (e) {
        console.log(pad(name, 12), " threw:", e.message);
        continue;
      }
      const dErr = gt.dive != null && r.dive != null ? r.dive - gt.dive : null;
      const tErr =
        gt.touch != null && r.touch != null ? r.touch - gt.touch : null;
      const divePass = dErr != null && Math.abs(dErr / FRAME) <= 2;
      const touchPass = tErr != null && Math.abs(tErr / FRAME) <= 3;
      const verdict = [
        gt.dive != null ? (divePass ? "dive PASS" : "dive FAIL") : null,
        gt.touch != null ? (touchPass ? "touch PASS" : "touch FAIL") : null,
      ]
        .filter(Boolean)
        .join("  ");
      console.log(
        pad(name, 12),
        padL(f3(gt.dive), 9),
        padL(f3(r.dive), 8),
        padL(frames(dErr), 10),
        padL(f2(gt.touch), 9),
        padL(f2(r.touch), 8),
        padL(frames(tErr), 10),
        padL(f3(r.turn), 8),
        padL(r.uncertainty == null ? "-" : String(r.uncertainty), 8),
        verdict || "(no gt)"
      );
      if (r.notes) console.log(pad("", 12), "notes:", r.notes);
    }
    console.log();
    return;
  }

  // ---- baseline: src/detect.js candidates ----------------------------------
  console.log("\nBASELINE  src/detect.js  (closest candidate to each event)\n");
  console.log(
    pad("clip", 12),
    padL("#cand", 6),
    padL("swim window", 16),
    padL("steady span", 16),
    padL("dive gt", 8),
    padL("closest", 8),
    padL("err(fr)", 8),
    padL("<=3fr", 6),
    padL("touch gt", 9),
    padL("closest", 8),
    padL("err(fr)", 8),
    padL("<=3fr", 6)
  );

  for (const name of names) {
    const gt = GROUND_TRUTH[name] || { dive: null, touch: null };
    const { samples, fps, duration } = loadFixture(name);
    const r = detect(samples, fps);
    if (r.error) {
      console.log(pad(name, 12), " detect() error:", r.error);
      continue;
    }
    const cd = closest(r.candidates, gt.dive);
    const ct = closest(r.candidates, gt.touch);
    const dErr = cd ? cd.t - gt.dive : null;
    const tErr = ct ? ct.t - gt.touch : null;
    const win = `${f2(r.swim[0])}-${f2(r.swim[1])}`;
    const steady = `${f2(r.steadyFrom)}-${f2(r.steadyTo)}`;
    console.log(
      pad(name, 12),
      padL(r.candidates.length, 6),
      padL(win, 16),
      padL(steady, 16),
      padL(f2(gt.dive), 8),
      padL(cd ? cd.t.toFixed(2) : "-", 8),
      padL(frames(dErr), 8),
      padL(dErr != null ? (Math.abs(dErr / FRAME) <= 3 ? "yes" : "no") : "-", 6),
      padL(f2(gt.touch), 9),
      padL(ct ? ct.t.toFixed(2) : "-", 8),
      padL(frames(tErr), 8),
      padL(tErr != null ? (Math.abs(tErr / FRAME) <= 3 ? "yes" : "no") : "-", 6)
    );
  }

  console.log("\ncandidate lists:\n");
  for (const name of names) {
    const { samples, fps } = loadFixture(name);
    const r = detect(samples, fps);
    if (r.error) continue;
    const gt = GROUND_TRUTH[name] || {};
    console.log(
      `  ${pad(name, 12)} roiFrac ${r.roiFrac.toFixed(3)}  ` +
        `candidates ` +
        r.candidates
          .map((c) => `t=${c.t.toFixed(2)}(peak ${c.peak.toFixed(2)}, v ${c.v.toFixed(1)})`)
          .join("  ")
    );
    const containsDive =
      gt.dive != null && r.swim[0] <= gt.dive && gt.dive <= r.swim[1];
    const containsTouch =
      gt.touch != null && r.swim[0] <= gt.touch && gt.touch <= r.swim[1];
    const wholeClip = r.swim[1] - r.swim[0] > 0.9 * (r.steadyTo - r.steadyFrom);
    console.log(
      `  ${pad("", 12)} swim ${f2(r.swim[0])}-${f2(r.swim[1])}s vs ` +
        `dive ${f2(gt.dive)} / touch ${f2(gt.touch)}  -> ` +
        (wholeClip
          ? "swim window is ~whole clip (no sustained run found; fell back)"
          : `swim window ${containsDive ? "contains" : "MISSES"} dive, ${
              gt.touch != null ? (containsTouch ? "contains" : "MISSES") + " touch" : "no touch gt"
            }`)
    );
  }
  console.log();
}

main();
