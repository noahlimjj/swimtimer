/* ---------------------------------------------------------------------------
   test/smoke.test.mjs

   There was no test suite in the repo before this harness, so there is no prior
   SSR smoke render test to port. src/App.jsx is JSX and the project has no
   Node-side transform configured (Vite only transforms for the browser build),
   so `node --test` cannot import the component directly. The SSR render check is
   therefore left as an explicit skip; `npm run build` remains the check that the
   component compiles.

   What we can smoke-test here is that detect.js is genuinely portable: it must
   import and run with no DOM / browser globals present.
   --------------------------------------------------------------------------- */

import test from "node:test";
import assert from "node:assert/strict";

test("detect.js imports with no browser globals", async () => {
  // Node 22 exposes a `navigator` global, so only the DOM-specific ones are
  // meaningful here.
  for (const g of ["window", "document"]) {
    assert.equal(typeof globalThis[g], "undefined", `${g} leaked into test env`);
  }
  const mod = await import("../src/detect.js");
  assert.equal(typeof mod.detect, "function");
});

test("detect() rejects a too-short sample array without throwing", async () => {
  const { detect } = await import("../src/detect.js");
  const r = detect([{ t: 0, frac: 0, cells: new Uint8Array(16) }], 30);
  assert.ok(r && r.error, "expected an { error } result for < 20 samples");
});

test("SSR smoke render of <App/>", { skip: "no Node-side JSX transform; covered by `npm run build`" }, () => {});
