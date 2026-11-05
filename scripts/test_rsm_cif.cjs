#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Cif = require("../assets/js/rsm-cif.js");
let checks = 0;
function test(name, fn) {
  try { fn(); checks++; console.log("ok - " + name); }
  catch (error) { console.error("FAIL - " + name); throw error; }
}
const COLUMNS = ["label", "type_symbol", "fract_x", "fract_y", "fract_z", "occupancy", "U_iso_or_equiv"];
function fixture(options = {}) {
  const cell = options.cell || [4, 4, 4, 90, 90, 90];
  const columns = options.columns || COLUMNS;
  const rows = options.rows || ["C1 C 0 0 0 1 0.005"];
  return [
    "data_" + (options.name || "test"),
    ...["length_a", "length_b", "length_c", "angle_alpha", "angle_beta", "angle_gamma"].map((key, index) => "_cell_" + key + " " + cell[index]),
    options.group === undefined ? "_space_group_name_H-M_alt 'P 1'" : options.group,
    options.ops ? "loop_\n_space_group_symop_operation_xyz\n" + options.ops.map(op => "'" + op + "'").join("\n") : "",
    "loop_", ...columns.map(column => "_atom_site_" + column), ...rows,
    options.extra || ""
  ].filter(Boolean).join("\n") + "\n";
}
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + " != " + expected);
const forbidden = (source, expression) => assert.throws(() => Cif.parse(source), expression);
function basisIntensity(atoms, hkl) {
  let real = 0, imaginary = 0;
  for (const atom of atoms) {
    const phase = 2 * Math.PI * (hkl[0] * atom.x + hkl[1] * atom.y + hkl[2] * atom.z);
    real += atom.occupancy * Math.cos(phase);
    imaginary += atom.occupancy * Math.sin(phase);
  }
  return real * real + imaginary * imaginary;
}

test("P1 supplies identity only when unequivocally declared", () => {
  const parsed = Cif.parse(fixture());
  assert.equal(parsed.blockName, "test");
  assert.deepEqual(parsed.cell, { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 });
  assert.deepEqual(parsed.symops, ["x,y,z"]);
  assert.equal(parsed.expandedAtoms.length, 1);
  assert.ok(parsed.warnings.some(w => /P1.*identity/.test(w)));
  assert.equal(Cif.parse(fixture({ group: "_space_group_IT_number 1" })).spaceGroupNumber, 1);
  assert.equal(Cif.parse(fixture({ group: "_space_group_name_Hall 'P 1'" })).symops.length, 1);
  forbidden(fixture({ group: "_space_group_name_H-M_alt 'P -1'" }), /explicit symmetry/);
  forbidden(fixture({ group: "" }), /explicit symmetry/);
  forbidden(fixture({ group: "_space_group_IT_number 2\n_space_group_name_H-M_alt 'P1'" }), /conflicting/);
  forbidden(fixture({ ops: ["x,y,z", "-x,-y,-z"] }), /P1 declaration conflicts/);
  forbidden(fixture({ group: "_space_group_IT_number 2", ops: ["x,y,z"] }), /identity-only/);
});

test("CIF tokenization handles quoted comments, embedded quotes, CRLF, wrapped and same-line loop rows", () => {
  const text = fixture({
    rows: ["'C#1' C", ".1 .2", ".3 1 0.005 C2 C .4 .5 .6 1 0.01 # outside comment"],
    extra: "_chemical_formula_sum 'C2 # literal'\n_publ_section_title\n;O'Brien's study\nwraps onto a second line.\n;\n_note \"don't split me\"\n_reserved 'data_quoted'\n_embedded_hash value#literal"
  }).replace(/\n/g, "\r\n");
  const parsed = Cif.parse(text);
  assert.equal(parsed.atoms.length, 2);
  assert.equal(parsed.atoms[0].label, "C#1");
  assert.equal(parsed.formula, "C2 # literal");
  near(parsed.atoms[1].z, 0.6);
  assert.equal(Cif.parse(fixture({ rows: ['"C\'1" C 0 0 0 1 0'] })).atoms[0].label, "C'1");
});

test("uncertainty notation is strict and never accepts a numeric prefix", () => {
  const parsed = Cif.parse(fixture({ cell: ["4.123(2)", "4.2(1)e0", ".4e1", "9.0(1)e1", 90, 90], rows: ["C1 C .1234(6) 0 0 1 0"] }));
  near(parsed.cell.a, 4.123);
  near(parsed.cell.b, 4.2);
  near(parsed.atoms[0].x, 0.1234);
  near(Cif.parse(fixture({ cell: ["4.123e1(2)", 4, 4, 90, 90, 90] })).cell.a, 41.23);
  for (const value of ["4junk", "4(2)junk", "4(2)e1(3)", "4/2", "Infinity", "NaN", "1e999", "?"]) {
    forbidden(fixture({ cell: [value, 4, 4, 90, 90, 90] }), /finite number/);
  }
});

test("multiple data blocks never mix and require explicit selection", () => {
  const text = fixture({ name: "first" }) + fixture({ name: "SECOND", cell: [5, 5, 5, 90, 90, 90] });
  assert.deepEqual(Cif.blocks(text), ["first", "SECOND"]);
  forbidden(text, /multiple data blocks/);
  assert.equal(Cif.parse(text, "second").cell.a, 5);
  assert.equal(Cif.parse(text, "data_first").cell.a, 4);
  assert.throws(() => Cif.parse(text, "missing"), /not found/);
  forbidden(fixture() + fixture(), /duplicate data block/);
  assert.equal(Cif.parse(fixture({ name: "data_named" }), "data_named").blockName, "data_named");
});

test("invalid loop lengths, missing coordinates, and duplicate fields are rejected", () => {
  forbidden(fixture({ rows: ["C1 C 0 0 0 1"] }), /incomplete loop row/);
  forbidden(fixture({ rows: ["C1 C 0 ? 0 1 0"] }), /fract_y.*finite number/);
  forbidden(fixture({ columns: ["label", "type_symbol", "fract_x", "fract_z"], rows: ["C1 C 0 0"] }), /missing _atom_site_fract_y/);
  forbidden(fixture({ extra: "_cell_length_a 5" }), /duplicate field/);
  forbidden(fixture({ extra: "_missing\nloop_\n_foo\n1" }), /missing value/);
  forbidden(fixture({ extra: "loop_\n_empty\n" }), /incomplete loop row/);
  forbidden(fixture({ rows: ["C1 C 0 0 0 1 0", "C2 C ? 0 0 1 0"] }), /C2.*fract_x/);
});

test("nonorthogonal metrics are supported and impossible metrics fail", () => {
  assert.equal(Cif.parse(fixture({ cell: [3, 4, 5, 70, 80, 75] })).cell.gamma, 75);
  assert.equal(Cif.parse(fixture({ cell: [3, 3, 5, 90, 90, 120] })).cell.gamma, 120);
  forbidden(fixture({ cell: [3, 4, 5, 10, 10, 170] }), /cell metric/);
  forbidden(fixture({ cell: [0, 4, 5, 90, 90, 90] }), /positive/);
  forbidden(fixture({ cell: [4, 4, 5, 180, 90, 90] }), /angles/);
});

test("I-centering expansion reproduces parity extinction and allowed intensity", () => {
  const result = Cif.parse(fixture({ group: "_space_group_name_H-M_alt 'I 1'", ops: ["x,y,z", "x+1/2,y+1/2,z+1/2"] }));
  assert.equal(result.expandedAtoms.length, 2);
  near(basisIntensity(result.expandedAtoms, [1, 0, 0]), 0);
  near(basisIntensity(result.expandedAtoms, [1, 1, 0]), 4);
  near(basisIntensity(result.expandedAtoms, [1, 1, 1]), 0);
});

test("basis interference is preserved even with no crystallographic centering", () => {
  const result = Cif.parse(fixture({ rows: ["C1 C 0 0 0 1 0", "C2 C .5 .5 .5 1 0"] }));
  near(basisIntensity(result.expandedAtoms, [0, 0, 1]), 0);
  near(basisIntensity(result.expandedAtoms, [0, 0, 2]), 4);
});

test("inversion deduplicates special positions per site, preserving independent co-occupying atoms", () => {
  const result = Cif.parse(fixture({
    group: "_space_group_IT_number 2", ops: ["x,y,z", "-x,-y,-z"],
    rows: ["C1 C 0 0 0 .4 0", "C2 C 0 0 0 .6 0", "O1 O .1 .2 .3 1 0"]
  }));
  assert.equal(result.expandedAtoms.length, 4);
  assert.equal(result.expandedAtoms.filter(atom => atom.element === "C").length, 2);
  near(result.expandedAtoms.filter(atom => atom.element === "C").reduce((sum, atom) => sum + atom.occupancy, 0), 1);
  assert.ok(result.expandedAtoms.some(atom => atom.element === "O" && Math.abs(atom.x - 0.9) < 1e-12));
  const roundedDuplicate = Cif.parse(fixture({ ops: ["x,y,z", "x+0.0000005,y,z"] }));
  assert.equal(roundedDuplicate.expandedAtoms.length, 1, "symmetry validation and deduplication must agree about numerical equivalence");
});

test("hexagonal coordinate mixing and rational translations are parsed without eval", () => {
  const result = Cif.parse(fixture({
    cell: [3, 3, 5, 90, 90, 120], group: "_space_group_IT_number 144",
    ops: ["x,y,z", "-y,x-y,z+1/3", "-x+y,-x,z+2/3"],
    rows: ["C1 C .1 .2 .3 1 0"]
  }));
  assert.equal(result.expandedAtoms.length, 3);
  near(result.expandedAtoms[1].x, 0.8);
  near(result.expandedAtoms[1].y, 0.9);
  near(result.expandedAtoms[1].z, 0.3 + 1 / 3);
});

test("malformed, singular, nonfinite, incomplete, and executable symmetry is rejected", () => {
  for (const operation of ["x,y", "x,y,z,1", "x,y,0", "2*x,y,z", "x++1/2,y,z", "x+,y,z", "x+1/0,y,z", "x+foo,y,z", "x*y,y,z", "Math.random(),y,z", "x;alert(1),y,z", "x/2,y,z", "x+y,y,z"]) {
    forbidden(fixture({ group: "", ops: ["x,y,z", operation] }), /symmetry|division|rotation/);
  }
  forbidden(fixture({ group: "", ops: ["-x,-y,-z"] }), /identity/);
  forbidden(fixture({ group: "", ops: ["x,y,z", "x+1/3,y,z"] }), /incomplete/);
});

test("occupancies and displacement factors are bounded and Uiso converts to Biso", () => {
  near(Cif.parse(fixture()).atoms[0].biso, 8 * Math.PI * Math.PI * 0.005);
  const result = Cif.parse(fixture({ columns: ["label", "type_symbol", "fract_x", "fract_y", "fract_z", "B_iso_or_equiv"], rows: ["C1 C 0 0 0 0.5"] }));
  near(result.atoms[0].biso, 0.5);
  assert.equal(result.atoms[0].occupancy, 1);
  assert.ok(result.warnings.some(w => /occupancies/.test(w)));
  for (const occupancy of ["-0.1", "1.1", "?", "nan"]) forbidden(fixture({ rows: ["C1 C 0 0 0 " + occupancy + " 0"] }), /occupancy/);
  forbidden(fixture({ rows: ["C1 C 0 0 0 1 -0.01"] }), /nonnegative/);
  forbidden(fixture({ columns: [...COLUMNS, "B_iso_or_equiv"], rows: ["C1 C 0 0 0 1 0.01 2"] }), /inconsistent/);
});

test("anisotropic-only values trigger a visible omission warning", () => {
  const result = Cif.parse(fixture({
    columns: ["label", "type_symbol", "fract_x", "fract_y", "fract_z", "adp_type"],
    rows: ["C1 C 0 0 0 Uani"],
    extra: "loop_\n_atom_site_aniso_label\n_atom_site_aniso_U_11\n_atom_site_aniso_U_22\n_atom_site_aniso_U_33\nC1 .01 .02 .03"
  }));
  assert.equal(result.atoms[0].biso, 0);
  assert.ok(result.warnings.some(w => /Anisotropic-only/.test(w)));
});

test("valid elements outside a form-factor subset are retained and label inference is explicit", () => {
  assert.equal(Cif.parse(fixture({ rows: ["Og1 Og 0 0 0 1 0"] })).atoms[0].element, "Og");
  assert.equal(Cif.parse(fixture({ rows: ["Fe1 Fe3+ 0 0 0 1 0"] })).atoms[0].element, "Fe");
  const result = Cif.parse(fixture({ columns: ["label", "fract_x", "fract_y", "fract_z"], rows: ["Si1 0 0 0", "OW1 .1 .2 .3", "CL1 .2 .3 .4"] }));
  assert.deepEqual(result.atoms.map(atom => atom.element), ["Si", "O", "Cl"]);
  assert.ok(result.warnings.some(w => /inferred/.test(w)));
  forbidden(fixture({ rows: ["M1 M 0 0 0 1 0"] }), /unknown element/);
  assert.equal(Cif.parse(fixture({ rows: ["D1 D 0 0 0 1 0"] })).atoms[0].element, "H");
});

test("CIF2, modulated structures, save frames, and unterminated strings fail clearly", () => {
  forbidden("#\\#CIF_2.0\n" + fixture(), /CIF2/);
  forbidden(fixture({ extra: "_list [1 2 3]" }), /CIF2/);
  forbidden(fixture({ extra: "_cell_modulation_dimension 1" }), /modulated/);
  forbidden(fixture({ extra: "_space_group_ssg_name 'P1(abc)'" }), /modulated/);
  forbidden(fixture({ extra: "save_frame\n_tag 1\nsave_" }), /save frames/);
  forbidden(fixture({ extra: "_broken 'unterminated" }), /unterminated/);
  forbidden(fixture({ extra: "_broken\n;\nunterminated" }), /unterminated/);
});

test("resource limits bound bytes, sites, symmetry operations, and expanded atoms", () => {
  forbidden("#" + "x".repeat(Cif.limits.bytes) + "\n" + fixture(), /512 KiB/);
  forbidden(fixture({ rows: Array.from({ length: 513 }, (_, i) => "C" + i + " C 0 0 0 1 0") }), /512 asymmetric/);
  forbidden(fixture({ ops: Array.from({ length: 193 }, () => "x,y,z") }), /192 symmetry/);
  forbidden(fixture({
    group: "",
    ops: Array.from({ length: 16 }, (_, i) => "x+" + i + "/16,y,z"),
    rows: Array.from({ length: 257 }, (_, i) => "C" + i + " C .001 .002 .003 1 0")
  }), /4096 atoms/);
});

test("module also exposes its browser UMD API without CommonJS", () => {
  const context = { self: {}, TextEncoder };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../assets/js/rsm-cif.js"), "utf8"), context);
  assert.equal(typeof context.self.RsmCif.parse, "function");
  assert.equal(context.self.RsmCif.parse(fixture()).cell.a, 4);
});

test("all cached VO2 CIFs retain PhaseCore cells, sites, symmetry, and expanded coordinates", () => {
  const PhaseCore = require("../assets/js/phase-core.js");
  const cache = require("../data/phases/VO2.json");
  assert.ok(cache.entries.length > 0, "cached real-world CIF fixtures must exist");
  for (const entry of cache.entries) {
    const old = PhaseCore.parseCif(entry.cif);
    const current = Cif.parse(entry.cif);
    assert.deepEqual(current.cell, old.cell, "cell differs for COD " + entry.cod_id);
    assert.equal(current.formula, old.formula, "formula differs for COD " + entry.cod_id);
    assert.equal(current.spaceGroup, old.spaceGroup, "space group differs for COD " + entry.cod_id);
    assert.equal(current.spaceGroupNumber, old.spaceGroupNumber, "space group number differs for COD " + entry.cod_id);
    assert.deepEqual(current.symops, old.symops, "symmetry differs for COD " + entry.cod_id);
    assert.equal(current.atoms.length, old.atoms.length, "site count differs for COD " + entry.cod_id);
    current.atoms.forEach((atom, i) => {
      const { biso, ...withoutDisplacement } = atom;
      assert.deepEqual(withoutDisplacement, old.atoms[i], "asymmetric site differs for COD " + entry.cod_id);
      assert.ok(Number.isFinite(biso) && biso >= 0);
    });
    const oldExpanded = PhaseCore.expandAtoms(old.atoms, old.symops);
    assert.equal(current.expandedAtoms.length, oldExpanded.length, "expanded count differs for COD " + entry.cod_id);
    current.expandedAtoms.forEach((atom, i) => {
      const previous = oldExpanded[i];
      for (const key of ["label", "element", "occupancy"]) assert.equal(atom[key], previous[key], key + " differs for COD " + entry.cod_id);
      for (const key of ["x", "y", "z"]) near(atom[key], previous[key], 1e-10);
    });
  }
  console.log("  compared " + cache.entries.length + " cached CIF structures");
});

console.log(checks + " CIF parser tests passed.");
