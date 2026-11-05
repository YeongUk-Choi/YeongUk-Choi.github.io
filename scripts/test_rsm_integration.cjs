/* Parser → form factors → numerical core → shipped worker integration.
   This is not a browser/UI test. The VM executes the real worker entry point
   and imports, with structuredClone implementing its message/transfer boundary. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Cif = require("../assets/js/rsm-cif.js");
const Rsm = require("../assets/js/rsm-core.js");
const Examples = require("../data/rsm-examples.js");
const Xrd = require("../assets/xrd/xrd_core.js");
Xrd.useData(require("../assets/xrd/xrd_data.json"));
let count = 0;
function test(name, run) { run(); count++; console.log("ok - " + name); }
function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + " != " + expected);
}
function layer(text, id) {
  const parsed = Cif.parse(text);
  return {
    id, parsed, cell: { ...parsed.cell }, out: [0, 0, 1], in: [1, 0, 0],
    tilt: 0, azimuth: 0, scale: id === "film" ? 0.4 : 1,
    mosaicDeg: id === "film" ? 0.08 : 0.01,
    microstrain: id === "film" ? 0.0005 : 0,
    ...(id === "film" ? { thicknessNm: 50, coherenceNm: 150, variants: [{ tilt: 0, azimuth: 0, weight: 1 }] } : { substrateFwhm: 0.001 })
  };
}
function demoState() {
  const state = {
    substrate: layer(Examples.substrate, "substrate"),
    film: layer(Examples.film, "film"),
    plane: "xz", slice: 0, lambda: 1.540593, twoThetaMax: 160,
    instrument: { sigmaX: 0.001, sigmaY: 0.001, sigmaZ: 0.001 },
    maxIndex: 6, qmax: 1.3, threshold: 0.004, mask: true,
    grid: { width: 600, height: 450, xmin: -1.05, xmax: 1.05, ymin: 0, ymax: 1.25 }
  };
  // The actual Demo action applies this c edit after parsing the cubic CIF.
  state.film.cell.c = 4.02;
  return state;
}
const state = demoState();
let demo;

test("the shipped two-CIF example computes at the actual default 600×450 grid", () => {
  const before = JSON.stringify(state);
  demo = Rsm.simulate(state);
  assert.equal(JSON.stringify(state), before, "calculation must not mutate parsed/reference cells");
  assert.equal(demo.total.length, 600 * 450);
  assert.ok(demo.max > 0);
  assert.ok(demo.stats.rendered > 0);
  assert.ok(demo.stats.work <= Rsm.limits.gridWork);
  assert.ok(demo.reflections.some(r => r.layer === "substrate"));
  assert.ok(demo.reflections.some(r => r.layer === "film"));
  const substrate002 = demo.reflections.find(r => r.layer === "substrate" && r.h === 0 && r.k === 0 && r.l === 2);
  const film002 = demo.reflections.find(r => r.layer === "film" && r.h === 0 && r.k === 0 && r.l === 2);
  near(substrate002.q[2], 2 / 3.905);
  near(film002.q[2], 2 / 4.02);
  near(state.film.parsed.cell.c, 3.95, 1e-12);
  for (let i = 0; i < demo.total.length; i++) {
    assert.ok(Number.isFinite(demo.total[i]) && demo.total[i] >= 0);
    near(demo.total[i], demo.substrate[i] + demo.film[i], Math.max(1, demo.total[i]) * 1e-7);
  }
});

test("parsed biso actually attenuates the demo structure factor across the module boundary", () => {
  const parsed = state.substrate.parsed, q = 2 / parsed.cell.c;
  assert.ok(parsed.expandedAtoms.every(atom => atom.biso === 0.4));
  const actual = Rsm.structureFactor(parsed.expandedAtoms, 0, 0, 2, q);
  const zeroB = Rsm.structureFactor(parsed.expandedAtoms.map(atom => ({ ...atom, biso: 0 })), 0, 0, 2, q);
  near(actual / zeroB, Math.exp(-2 * 0.4 * (q / 2) ** 2));
});

test("changing wavelength preserves all reciprocal positions and the unmasked map", () => {
  const short = Rsm.simulate({ ...state, lambda: 0.8, mask: false });
  const long = Rsm.simulate({ ...state, lambda: 2.2, mask: false });
  const positions = result => result.reflections.map(r => [r.layer, r.h, r.k, r.l, r.variant, r.q, r.F2]);
  assert.deepEqual(positions(short), positions(long));
  assert.deepEqual(short.total, long.total);
  assert.ok(short.reflections.some((r, i) => r.angles?.accessible !== long.reflections[i].angles?.accessible));
  const remasked = Rsm.simulate({ ...state, lambda: 2.2, mask: true });
  assert.deepEqual(positions(remasked), positions(long));
  assert.ok(remasked.total.some((value, i) => value !== long.total[i]), "only geometry masking should remove inaccessible map pixels");
});

test("a cached rutile CIF obeys screw/glide extinctions and matches XRD's 2π convention", () => {
  const entry = require("../data/phases/VO2.json").entries.find(item => item.cod_id === "1539951");
  assert.ok(entry, "the committed COD rutile fixture must remain available");
  const rutile = layer(entry.cif, "film"), parsed = rutile.parsed;
  assert.equal(parsed.spaceGroupNumber, 136);
  assert.equal(parsed.expandedAtoms.length, 6);
  const oxygen = parsed.atoms.find(atom => atom.element === "O");
  assert.ok(oxygen && oxygen.x === oxygen.y && oxygen.z === 0);
  const result = Rsm.reflections(rutile, { maxIndex: 3, qmax: 1.4, threshold: 0 });
  for (const hkl of [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1, 0, 2], [0, 0, 2], [1, 0, 1], [1, 1, 0], [1, 1, 1], [1, 1, 2]]) {
    const d = Xrd.dSpacing(parsed.cell.a, hkl, parsed.cell.c, "tetragonal");
    const q = 1 / d, twoTheta = Xrd.braggAngle(parsed.cell.a, hkl, 1.540593, parsed.cell.c, "tetragonal");
    near(2 * Math.sin(twoTheta * Math.PI / 360) / 1.540593, q);
    const value = Rsm.structureFactor(parsed.expandedAtoms, ...hkl, q);
    const amplitude = Xrd.rutileBasisAmplitude(2 * Math.PI * q, q / 2, parsed.cell.a, parsed.cell.c, hkl, "V", oxygen.x);
    const xrdValue = amplitude[0] ** 2 + amplitude[1] ** 2;
    near(value, xrdValue, Math.max(1, xrdValue) * 1e-10);
    const reflection = result.reflections.find(r => r.h === hkl[0] && r.k === hkl[1] && r.l === hkl[2]);
    if (Xrd.rutileReflectionAbsent(hkl)) {
      assert.ok(value < 1e-18);
      assert.equal(reflection, undefined);
    } else {
      assert.ok(reflection, "allowed rutile reflection " + hkl.join(" ") + " is missing");
      near(reflection.qabs, q);
    }
  }
  assert.ok(result.nearZero > 0);
  assert.equal(result.hidden, 0, "extinction exclusion must not be reported as display-threshold hiding");
});

test("the shipped worker imports real modules and transfers all three complete grids", () => {
  const directory = path.join(__dirname, "../assets/js");
  const messages = [], transfers = [];
  const sandbox = { performance, Float32Array, console };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      assert.ok(["phase-core.js", "rsm-factors.js", "rsm-core.js"].includes(name));
      vm.runInContext(fs.readFileSync(path.join(directory, name), "utf8"), context, { filename: name });
    }
  };
  sandbox.postMessage = (message, buffers = []) => {
    transfers.push(buffers);
    messages.push(structuredClone(message, { transfer: buffers }));
  };
  vm.runInContext(fs.readFileSync(path.join(directory, "rsm-worker.js"), "utf8"), context, { filename: "rsm-worker.js" });
  sandbox.onmessage({ data: structuredClone({ id: 73, state }) });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 73);
  assert.equal(messages[0].error, undefined);
  assert.equal(transfers[0].length, 3);
  assert.equal(new Set(transfers[0]).size, 3);
  assert.ok(transfers[0].every(buffer => buffer.byteLength === 0), "transfer must detach the worker-owned grids");
  const received = messages[0].result;
  for (const key of ["substrate", "film", "total"]) {
    assert.ok(received[key] instanceof Float32Array);
    assert.deepEqual(received[key], demo[key]);
  }
  assert.deepEqual(received.reflections, demo.reflections);
  assert.ok(Number.isFinite(received.elapsedMs) && received.elapsedMs >= 0);
  sandbox.onmessage({ data: structuredClone({ id: 74, state: { ...state, grid: { ...state.grid, xmax: state.grid.xmin } } }) });
  assert.equal(messages[1].id, 74);
  assert.match(messages[1].error, /maximum.*minimum/i);
  assert.equal(messages[1].result, undefined, "a failed request must not re-emit a previous successful result");
});

console.log(count + " RSM integration checks passed (no browser UI exercised).");
