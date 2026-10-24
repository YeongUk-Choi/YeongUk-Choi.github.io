/* Crystallography for the phase viewer: CIF in, lattices and reflections out.

   Kept free of the DOM so the same functions run under node in
   scripts/test_phase_core.mjs. Nothing here fetches anything; the caller
   supplies CIF text (from the prebuilt data/phases cache or from COD).

   Conventions: lattice vectors are rows of a 3x3 in the crystallographic
   Cartesian setting (a along x, b in the xy plane). Reciprocal vectors carry
   no 2pi, so |q| = 1/d and reflection hkl sits at h a* + k b* + l c*. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PhaseCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const D2R = Math.PI / 180;
  /* COD writes uncertainties inline: 5.752316(24). The digits in the bracket are
     the e.s.d. of the last figures, never part of the value. */
  const num = s => {
    if (s == null) return null;
    const v = parseFloat(String(s).replace(/\(.*?\)/g, "").trim());
    return Number.isFinite(v) ? v : null;
  };
  /* 'V3+', 'O2-', 'Nb1' all mean one chemical element. */
  const element = s => {
    const m = /^([A-Z][a-z]?)/.exec(String(s || "").trim());
    return m ? m[1] : "";
  };

  /* ---------- CIF ---------- */

  /* A reader for the CIF subset COD actually emits: tag/value pairs, loop_
     blocks, single and double quoted strings, and semicolon text fields. It is
     deliberately not a full STAR parser - anything it cannot read becomes a
     missing field, which the caller reports, rather than a wrong number. */
  function parseCif(text) {
    const lines = String(text).split(/\r?\n/);
    const tags = {}, loops = [];
    let i = 0;
    const splitValues = line => {
      const out = [];
      const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
      let m;
      while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
      return out;
    };
    const readSemicolon = () => {              /* ;\n ... \n; multi-line value */
      const buf = [];
      i++;
      while (i < lines.length && !/^;/.test(lines[i])) buf.push(lines[i++]);
      i++;
      return buf.join("\n").trim();
    };
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();
      if (!t || t.startsWith("#") || /^data_/i.test(t)) { i++; continue; }
      if (/^loop_/i.test(t)) {
        i++;
        const names = [];
        while (i < lines.length && lines[i].trim().startsWith("_")) names.push(lines[i++].trim().split(/\s+/)[0].toLowerCase());
        const rows = [];
        while (i < lines.length) {
          const r = lines[i].trim();
          if (!r || r.startsWith("#")) { i++; continue; }
          if (r.startsWith("_") || /^loop_/i.test(r) || /^data_/i.test(r)) break;
          if (r.startsWith(";")) { rows.push([readSemicolon()]); continue; }
          let vals = splitValues(lines[i]); i++;
          /* A row may wrap; keep pulling lines until the row has one value per name. */
          while (vals.length < names.length && i < lines.length && !lines[i].trim().startsWith("_") && !/^loop_/i.test(lines[i].trim())) {
            vals = vals.concat(splitValues(lines[i])); i++;
          }
          rows.push(vals);
        }
        loops.push({ names, rows });
        continue;
      }
      if (t.startsWith("_")) {
        const parts = splitValues(t);
        const name = parts[0].toLowerCase();
        if (parts.length > 1) { tags[name] = parts.slice(1).join(" "); i++; continue; }
        i++;
        while (i < lines.length && !lines[i].trim()) i++;
        if (i < lines.length && lines[i].trim().startsWith(";")) tags[name] = readSemicolon();
        else if (i < lines.length) { tags[name] = splitValues(lines[i]).join(" "); i++; }
        continue;
      }
      i++;
    }
    const loopWith = tag => loops.find(l => l.names.includes(tag));
    const col = (loop, tag) => {
      const k = loop.names.indexOf(tag);
      return k < 0 ? null : loop.rows.map(r => r[k]);
    };

    const cell = {
      a: num(tags._cell_length_a), b: num(tags._cell_length_b), c: num(tags._cell_length_c),
      alpha: num(tags._cell_angle_alpha), beta: num(tags._cell_angle_beta), gamma: num(tags._cell_angle_gamma)
    };

    /* Symmetry comes from the file itself. Every COD entry carries the explicit
       operator list, so the viewer never needs a space-group table - and never
       has to guess a setting, which is where a table would go wrong. */
    const symLoop = loopWith("_symmetry_equiv_pos_as_xyz") || loopWith("_space_group_symop_operation_xyz");
    let symops = [];
    if (symLoop) {
      const c = col(symLoop, "_symmetry_equiv_pos_as_xyz") || col(symLoop, "_space_group_symop_operation_xyz");
      symops = c.map(s => String(s).replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
    }

    const atomLoop = loopWith("_atom_site_fract_x");
    const atoms = [];
    if (atomLoop) {
      const lab = col(atomLoop, "_atom_site_label") || [];
      const typ = col(atomLoop, "_atom_site_type_symbol") || [];
      const xs = col(atomLoop, "_atom_site_fract_x"), ys = col(atomLoop, "_atom_site_fract_y"), zs = col(atomLoop, "_atom_site_fract_z");
      const occ = col(atomLoop, "_atom_site_occupancy");
      for (let k = 0; k < xs.length; k++) {
        const x = num(xs[k]), y = num(ys[k]), z = num(zs[k]);
        if (x == null || y == null || z == null) continue;
        atoms.push({
          label: lab[k] || typ[k] || "?",
          element: element(typ[k] || lab[k]),
          x, y, z,
          occupancy: occ ? (num(occ[k]) ?? 1) : 1
        });
      }
    }

    return {
      cell, symops, atoms,
      formula: (tags._chemical_formula_sum || "").replace(/^['"]|['"]$/g, ""),
      spaceGroup: (tags["_symmetry_space_group_name_h-m"] || tags["_space_group_name_h-m_alt"] || "").replace(/^['"]|['"]$/g, ""),
      spaceGroupNumber: num(tags._space_group_it_number) ?? num(tags._symmetry_int_tables_number),
      z: num(tags._cell_formula_units_z),
      temperature: num(tags._cell_measurement_temperature) ?? num(tags._diffrn_ambient_temperature),
      codId: (tags._cod_database_code || "").trim(),
      title: (tags._publ_section_title || "").replace(/\s+/g, " ").trim(),
      journal: (tags._journal_name_full || "").replace(/^['"]|['"]$/g, ""),
      year: num(tags._journal_year)
    };
  }

  /* ---------- lattice ---------- */

  function cellVectors(cell) {
    const { a, b, c } = cell;
    const al = cell.alpha * D2R, be = cell.beta * D2R, ga = cell.gamma * D2R;
    const cx = c * Math.cos(be);
    const cy = c * (Math.cos(al) - Math.cos(be) * Math.cos(ga)) / Math.sin(ga);
    const cz2 = c * c - cx * cx - cy * cy;
    return [
      [a, 0, 0],
      [b * Math.cos(ga), b * Math.sin(ga), 0],
      [cx, cy, Math.sqrt(Math.max(cz2, 0))]
    ];
  }

  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const scale = (u, s) => [u[0] * s, u[1] * s, u[2] * s];
  const norm = u => Math.sqrt(dot(u, u));
  const volume = A => dot(A[0], cross(A[1], A[2]));

  /* No 2pi: |h a* + k b* + l c*| is 1/d, which is what a reciprocal-space map
     is drawn in. Mixing the two conventions silently rescales every figure. */
  function reciprocalVectors(A) {
    const V = volume(A);
    return [scale(cross(A[1], A[2]), 1 / V), scale(cross(A[2], A[0]), 1 / V), scale(cross(A[0], A[1]), 1 / V)];
  }

  /* The metric tensor is what survives when orientation is unknown. A CIF fixes
     the cell but says nothing about how the crystal sat in the diffractometer,
     so every comparison between two phases has to be made through G. */
  function metricTensor(A) {
    return [0, 1, 2].map(i => [0, 1, 2].map(j => dot(A[i], A[j])));
  }

  function cellFromVectors(A) {
    const a = norm(A[0]), b = norm(A[1]), c = norm(A[2]);
    const ang = (u, v, lu, lv) => Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)))) / D2R;
    return { a, b, c, alpha: ang(A[1], A[2], b, c), beta: ang(A[0], A[2], a, c), gamma: ang(A[0], A[1], a, b) };
  }

  /* ---------- symmetry ---------- */

  /* 'x,y,z', '-x+1/2,y+1/2,-z', '-y+2/3,x-y+1/3,z+1/3'. Each component is cut
     into signed terms first; a term carrying x, y or z is a matrix entry and a
     bare number or fraction is a translation. */
  const fraction = s => {
    const f = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(s);
    return f ? parseFloat(f[1]) / parseFloat(f[2]) : parseFloat(s);
  };
  function symopMatrix(op) {
    const rows = String(op).toLowerCase().replace(/\s+/g, "").split(",");
    if (rows.length !== 3) return null;
    const R = [], t = [];
    for (const raw of rows) {
      const r = [0, 0, 0];
      let shift = 0;
      for (const term of raw.match(/[+-]?[^+-]+/g) || []) {
        const sign = term[0] === "-" ? -1 : 1;
        const body = term.replace(/^[+-]/, "");
        const ax = /[xyz]/.exec(body);
        if (ax) {
          const coef = body.replace(/[xyz*]/g, "");
          r["xyz".indexOf(ax[0])] += sign * (coef ? fraction(coef) : 1);
        } else {
          const v = fraction(body);
          if (Number.isFinite(v)) shift += sign * v;
        }
      }
      R.push(r); t.push(shift);
    }
    return { R, t };
  }

  const wrap01 = v => { let x = v % 1; if (x < 0) x += 1; return x; };

  /* Expands the asymmetric unit. Duplicates are removed on fractional position
     with a 1e-3 tolerance; without that an atom on a special position is
     counted as many times as the site symmetry, which inflates every structure
     factor it contributes to. */
  function expandAtoms(atoms, symops) {
    const ops = (symops.length ? symops : ["x,y,z"]).map(symopMatrix).filter(Boolean);
    const out = [];
    const key = p => p.map(v => Math.round(wrap01(v) * 1000) % 1000).join(",");
    const seen = new Set();
    for (const at of atoms) {
      for (const op of ops) {
        const p = [0, 1, 2].map(i => wrap01(op.R[i][0] * at.x + op.R[i][1] * at.y + op.R[i][2] * at.z + op.t[i]));
        const k = at.label + "|" + key(p);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ label: at.label, element: at.element, occupancy: at.occupancy, x: p[0], y: p[1], z: p[2] });
      }
    }
    return out;
  }

  /* ---------- reflections ---------- */

  /* Scattering power is approximated by the atomic number. That is enough for
     what this figure claims: which reciprocal points exist (systematic absences
     are geometric and come out exactly) and roughly how strong they are. It is
     not a diffraction-intensity calculation - no form-factor fall-off, no
     thermal factor, no polarisation - and the page says so next to the plot. */
  const Z = { H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10, Na: 11, Mg: 12, Al: 13, Si: 14, P: 15, S: 16, Cl: 17, Ar: 18, K: 19, Ca: 20, Sc: 21, Ti: 22, V: 23, Cr: 24, Mn: 25, Fe: 26, Co: 27, Ni: 28, Cu: 29, Zn: 30, Ga: 31, Ge: 32, As: 33, Se: 34, Br: 35, Kr: 36, Rb: 37, Sr: 38, Y: 39, Zr: 40, Nb: 41, Mo: 42, Tc: 43, Ru: 44, Rh: 45, Pd: 46, Ag: 47, Cd: 48, In: 49, Sn: 50, Sb: 51, Te: 52, I: 53, Xe: 54, Cs: 55, Ba: 56, La: 57, Ce: 58, Pr: 59, Nd: 60, Pm: 61, Sm: 62, Eu: 63, Gd: 64, Tb: 65, Dy: 66, Ho: 67, Er: 68, Tm: 69, Yb: 70, Lu: 71, Hf: 72, Ta: 73, W: 74, Re: 75, Os: 76, Ir: 77, Pt: 78, Au: 79, Hg: 80, Tl: 81, Pb: 82, Bi: 83, Th: 90, U: 92 };

  function reflections(A, atoms, opts) {
    const o = Object.assign({ qmax: 1.2, maxIndex: 8, cut: 0.004 }, opts || {});
    const B = reciprocalVectors(A);
    const list = [];
    let peak = 0;
    for (let h = -o.maxIndex; h <= o.maxIndex; h++)
      for (let k = -o.maxIndex; k <= o.maxIndex; k++)
        for (let l = -o.maxIndex; l <= o.maxIndex; l++) {
          if (!h && !k && !l) continue;
          const q = [0, 1, 2].map(i => h * B[0][i] + k * B[1][i] + l * B[2][i]);
          const qlen = norm(q);
          if (qlen > o.qmax) continue;
          let re = 0, im = 0;
          for (const at of atoms) {
            const f = (Z[at.element] || 1) * at.occupancy;
            const ph = 2 * Math.PI * (h * at.x + k * at.y + l * at.z);
            re += f * Math.cos(ph); im += f * Math.sin(ph);
          }
          const F2 = re * re + im * im;
          if (F2 > peak) peak = F2;
          list.push({ h, k, l, q, qlen, F2 });
        }
    /* Absences are exact zeros in theory and rounding noise in floating point;
       anything under 0.4% of the strongest reflection is treated as absent. */
    return list.filter(r => r.F2 > peak * o.cut).sort((x, y) => y.F2 - x.F2).map(r => Object.assign(r, { rel: r.F2 / peak }));
  }

  /* ---------- orientation relation between two phases ---------- */

  /* Finds integer P with  A_target ~ P . A_reference, i.e. the target cell
     written on the reference lattice. Everything is done on metric tensors
     because neither CIF carries an orientation.

     This is a geometric coincidence search, not a group-subgroup derivation.
     A match means the two lattices CAN be drawn in one frame this way - it is
     a proposal for the user to accept, which is why the caller shows P and the
     misfit rather than quietly applying it. */
  function matchLattice(refCell, targetCell, opts) {
    const o = Object.assign({ maxIndex: 3, tol: 0.04 }, opts || {});
    const Aref = cellVectors(refCell), Atg = cellVectors(targetCell);
    const G = metricTensor(Aref), Gt = metricTensor(Atg);
    const len2 = v => {
      let s = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += v[i] * v[j] * G[i][j];
      return s;
    };
    const ip = (u, v) => {
      let s = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += u[i] * v[j] * G[i][j];
      return s;
    };
    const n = o.maxIndex;
    const cand = [[], [], []];
    const want = [Gt[0][0], Gt[1][1], Gt[2][2]];
    for (let u = -n; u <= n; u++) for (let v = -n; v <= n; v++) for (let w = -n; w <= n; w++) {
      if (!u && !v && !w) continue;
      const L = len2([u, v, w]);
      for (let i = 0; i < 3; i++) if (Math.abs(Math.sqrt(L / want[i]) - 1) <= o.tol) cand[i].push([u, v, w]);
    }
    const Vratio = Math.sqrt(det3(Gt) / det3(G));
    let best = null;
    for (const r0 of cand[0]) for (const r1 of cand[1]) {
      if (Math.abs(ip(r0, r1) - Gt[0][1]) > o.tol * Math.sqrt(want[0] * want[1]) + 1e-9) continue;
      for (const r2 of cand[2]) {
        if (Math.abs(ip(r0, r2) - Gt[0][2]) > o.tol * Math.sqrt(want[0] * want[2]) + 1e-9) continue;
        if (Math.abs(ip(r1, r2) - Gt[1][2]) > o.tol * Math.sqrt(want[1] * want[2]) + 1e-9) continue;
        const P = [r0, r1, r2];
        const d = detI(P);
        if (d <= 0) continue;                       /* keep handedness; -P is the same lattice */
        if (Math.abs(d / Vratio - 1) > 0.08) continue;
        /* Score on the six independent metric components, each relative to its
           own scale, so a long axis cannot hide a bad short one. */
        let worst = 0;
        for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
          const got = ip(P[i], P[j]), ref = Gt[i][j];
          const sc = Math.sqrt(want[i] * want[j]);
          worst = Math.max(worst, Math.abs(got - ref) / sc);
        }
        /* Prefer the smallest indices among equally good matches: a cell is
           described by many integer combinations and the compact one is the
           one a crystallographer would write down. */
        const span = P.flat().reduce((s, v) => s + v * v, 0);
        if (!best || worst < best.misfit - 1e-6 || (Math.abs(worst - best.misfit) < 1e-6 && span < best.span)) {
          best = { P, misfit: worst, span, det: d };
        }
      }
    }
    if (!best) return null;
    return { P: best.P, misfit: best.misfit, det: best.det, volumeRatio: Vratio };
  }

  function det3(M) {
    return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
      - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
      + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  }
  const detI = det3;

  /* Target lattice placed in the reference frame: rows of P times the reference
     vectors. Fractional coordinates are unchanged by this - only the frame is. */
  function applyMatrix(P, Aref) {
    return P.map(row => [0, 1, 2].map(j => row[0] * Aref[0][j] + row[1] * Aref[1][j] + row[2] * Aref[2][j]));
  }

  /* ---------- phase grouping ---------- */

  /* COD stores one record per publication, so VO2 returns four rutile papers
     and two M1 papers. Grouping has to be on the lattice, not the space-group
     number: C2/m covers both M2 (9.08 x 5.76 x 4.53) and the B phase
     (12.03 x 3.69 x 6.42), and merging them would be a physics error. */
  /* Cells are compared after sorting the three lengths, so the same phase
     reported in a permuted setting still matches, and linked transitively: four
     rutile papers run from a = 4.517 to 4.598 (doping and temperature) and
     belong in one group even though the ends differ by 1.8 %.

     This is a similarity heuristic, not a symmetry derivation. It answers "are
     these the same structure type", and the viewer labels each group by its COD
     records rather than asserting a phase name the database does not carry. */
  function groupPhases(records, opts) {
    const o = Object.assign({ lengthTol: 0.015, angleTol: 1.5 }, opts || {});
    const cellOf = r => r.cell || r;
    const sgOf = r => r.sgNumber ?? r.sg_number ?? r.spaceGroupNumber ?? 0;
    const sorted = r => { const c = cellOf(r); return [c.a, c.b, c.c].sort((x, y) => x - y); };
    const angles = r => { const c = cellOf(r); return [c.alpha ?? 90, c.beta ?? 90, c.gamma ?? 90].sort((x, y) => x - y); };
    const alike = (p, q) => sgOf(p) === sgOf(q)
      && sorted(p).every((v, i) => Math.abs(v / sorted(q)[i] - 1) <= o.lengthTol)
      && angles(p).every((v, i) => Math.abs(v - angles(q)[i]) <= o.angleTol);

    const group = records.map(() => -1);
    let n = 0;
    for (let i = 0; i < records.length; i++) {
      if (group[i] >= 0) continue;
      group[i] = n;
      /* Single linkage: a record joins the group if it resembles any member. */
      for (let changed = true; changed;) {
        changed = false;
        for (let j = 0; j < records.length; j++) {
          if (group[j] >= 0) continue;
          if (records.some((r, k) => group[k] === n && alike(r, records[j]))) { group[j] = n; changed = true; }
        }
      }
      n++;
    }
    const out = Array.from({ length: n }, () => []);
    records.forEach((r, i) => out[group[i]].push(r));
    /* Largest, then smallest volume first: the well-documented phases lead. */
    return out.sort((a, b) => b.length - a.length || (cellOf(a[0]).volume || 0) - (cellOf(b[0]).volume || 0));
  }

  return {
    parseCif, cellVectors, reciprocalVectors, metricTensor, cellFromVectors,
    symopMatrix, expandAtoms, reflections, matchLattice, applyMatrix, groupPhases,
    volume, norm, dot, cross, Z
  };
});
