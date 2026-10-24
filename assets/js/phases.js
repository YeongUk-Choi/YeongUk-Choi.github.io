/* Crystal Phase Viewer — type a composition, pick phases, draw them.

   The crystallography lives in phase-core.js; this file is the page: the COD
   record list, the selection rules, and the SVG.

   Two limits here are deliberate and are explained on the page rather than
   enforced silently:
   - Ten phases can be drawn side by side, but only three can be *overlaid*.
     Three colours is what a validated categorical palette carries in a scatter
     where every pair is adjacent; past that, two phases become indistinguishable
     for a colourblind reader and often for everyone else. Panels have titles, so
     panels have no such limit.
   - Overlaying needs a shared frame. A CIF fixes a cell but not an orientation,
     so the viewer searches for an integer relation between the two lattices and
     shows it. A found relation is a proposal, not a derivation. */
(function () {
  "use strict";
  const C = window.PhaseCore;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs, kids) => {
    const n = document.createElementNS(tag === "div" || tag === "button" || tag === "label" || tag === "span" || tag === "input" || tag === "select" || tag === "option" || tag === "p" || tag === "a" ? "http://www.w3.org/1999/xhtml" : "http://www.w3.org/2000/svg", tag);
    for (const k in (attrs || {})) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(k => n.appendChild(k));
    return n;
  };

  /* Dark steps of the reference categorical palette; the light column is used
     for the white-background export. Slots are assigned in fixed order and
     never cycled - the fourth phase in an overlay is refused, not recoloured. */
  const SERIES = {
    dark: ["#3987e5", "#d95926", "#199e70"],
    light: ["#2a78d6", "#eb6834", "#1baf7a"]
  };
  const PANEL = { dark: "#3987e5", light: "#2a78d6" };
  const MARKS = ["circle", "square", "triangle"];   /* shape repeats the colour */
  const MAX_PANELS = 10, MAX_OVERLAY = 3;

  const state = {
    formula: "", data: null, groups: [], pick: {}, chosen: [],
    view: "reciprocal", mode: "panels", paper: false,
    yaw: -0.62, pitch: -0.42, qmax: 0.55, topN: 24, ref: 0
  };

  /* ---------- data ---------- */

  async function loadFormula(text) {
    const name = String(text || "").trim().replace(/\s+/g, "");
    if (!name) return;
    state.formula = name;
    status("COD 캐시를 읽는 중…");
    try {
      const r = await fetch(`data/phases/${encodeURIComponent(name)}.json`, { cache: "no-store" });
      if (!r.ok) throw new Error("not cached");
      state.data = await r.json();
    } catch (e) {
      state.data = null;
      state.groups = []; state.chosen = []; state.pick = {};
      render();
      const have = (window.PHASE_INDEX || []).map(x => x.formula);
      status(`‘${name}’은(는) 아직 이 사이트에 받아 둔 조성이 아닙니다. 지금 있는 것: ${have.join(", ") || "없음"}`, true);
      return;
    }
    /* One COD record is one publication, not one phase. Group first, then let
       the reader choose which record of a phase to draw. */
    const recs = state.data.entries.map(e => Object.assign({ id: String(e.cod_id), sgNumber: e.sg_number, cell: e }, e));
    state.groups = C.groupPhases(recs);
    state.pick = {}; state.chosen = []; state.ref = 0;
    state.groups.forEach((g, i) => { state.pick[i] = 0; });
    status(`COD 레코드 ${recs.length}건 → 구조 후보 ${state.groups.length}개 (받아 둔 날짜 ${state.data.fetched})`);
    render();
  }

  const status = (msg, warn) => {
    const n = $("#pv-status");
    n.textContent = msg || "";
    n.classList.toggle("warn", !!warn);
  };

  /* The CIF is parsed once per record and kept - every redraw would otherwise
     re-expand symmetry for nothing. */
  const cache = new Map();
  function structure(rec) {
    if (!cache.has(rec.id)) {
      const p = C.parseCif(rec.cif);
      p.atoms = C.expandAtoms(p.atoms, p.symops);
      p.vectors = C.cellVectors(p.cell);
      cache.set(rec.id, p);
    }
    return cache.get(rec.id);
  }

  const chosenRecords = () => state.chosen.map(i => state.groups[i][state.pick[i] || 0]);

  /* A name is only written where the database supports one; otherwise the
     candidate is identified by its space group and cell. */
  function groupLabel(g) {
    const r = g[0];
    const name = r.mineral || r.chemname || "";
    const cell = `${f(r.a)} × ${f(r.b)} × ${f(r.c)} Å`;
    return { head: `${r.spacegroup} (${r.sg_number || "?"})`, sub: cell, name: name && name.toLowerCase() !== (state.formula || "").toLowerCase() ? name : "" };
  }
  const f = v => (v == null ? "?" : (+v).toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));

  /* ---------- selection ---------- */

  function toggle(i, on) {
    const cap = state.mode === "overlay" ? MAX_OVERLAY : MAX_PANELS;
    if (on) {
      if (state.chosen.includes(i)) return;
      if (state.chosen.length >= cap) {
        status(state.mode === "overlay"
          ? `겹쳐보기는 ${MAX_OVERLAY}개까지입니다. 네 번째 색은 색각 이상에서 구분되지 않아 넣지 않습니다 — 나란히 보기로 바꾸면 ${MAX_PANELS}개까지 됩니다.`
          : `나란히 보기는 ${MAX_PANELS}개까지입니다.`, true);
        render(); return;
      }
      state.chosen.push(i);
    } else {
      state.chosen = state.chosen.filter(x => x !== i);
    }
    if (!state.chosen.includes(state.ref)) state.ref = state.chosen[0] ?? 0;
    status("");
    render();
  }

  /* ---------- geometry for drawing ---------- */

  function rotate(p) {
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    const cx = Math.cos(state.pitch), sx = Math.sin(state.pitch);
    const x = p[0] * cy + p[2] * sy;
    const z = -p[0] * sy + p[2] * cy;
    const y = p[1] * cx - z * sx;
    return [x, y, p[1] * sx + z * cx];
  }

  const cellEdges = A => {
    const o = [0, 0, 0];
    const v = (i, j, k) => [0, 1, 2].map(t => i * A[0][t] + j * A[1][t] + k * A[2][t]);
    const corner = [v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(0, 0, 1), v(1, 1, 0), v(1, 0, 1), v(0, 1, 1), v(1, 1, 1)];
    const pairs = [[0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 4], [2, 6], [3, 5], [3, 6], [4, 7], [5, 7], [6, 7]];
    return { corner, pairs, o };
  };

  /* Everything a panel draws, in one Cartesian frame, before projection. */
  function sceneFor(rec, frame) {
    const st = structure(rec);
    const A = frame || st.vectors;
    if (state.view === "reciprocal") {
      /* Reflections come back strongest first. A monoclinic cell four times the
         rutile volume has four times the reciprocal points, so drawing every
         one of them inside the same sphere buries the small cell and the figure
         stops carrying a message. Each phase contributes its strongest few. */
      const refl = C.reflections(A, st.atoms, { qmax: state.qmax, maxIndex: 5 }).slice(0, state.topN);
      const B = C.reciprocalVectors(A);
      return { kind: "q", points: refl.map(r => ({ p: r.q, r: 2.2 + 4.0 * Math.sqrt(r.rel), hkl: [r.h, r.k, r.l], rel: r.rel })), basis: B, st };
    }
    /* Real space: the asymmetric unit expanded over the cell, with the images
       on the far faces added so the box does not look half empty. */
    const pts = [];
    /* The heaviest element is drawn large and in the phase colour. CIFs list
       their sites in no fixed order - several COD VO2 records put O first - so
       taking atoms[0] would have labelled the oxygen sublattice as the cation
       one and reported an O-O distance as the metal-metal contact. */
    const first = st.atoms.reduce((best, a) => (C.Z[a.element] || 0) > (C.Z[best] || 0) ? a.element : best, "");
    for (const at of st.atoms) {
      const reps = [[at.x, at.y, at.z]];
      for (const ax of [0, 1, 2]) {
        const base = reps.slice();
        for (const q of base) if (q[ax] < 0.02) { const c = q.slice(); c[ax] = q[ax] + 1; reps.push(c); }
      }
      for (const q of reps) {
        const p = [0, 1, 2].map(t => q[0] * A[0][t] + q[1] * A[1][t] + q[2] * A[2][t]);
        pts.push({ p, r: at.element === first ? 6 : 3.4, major: at.element === first, label: at.element, frac: q });
      }
    }
    return { kind: "r", points: pts, basis: A, st, major: first };
  }

  /* Only the shortest class of cation-cation contacts is drawn: everything
     within 15 % of the shortest one. A fixed cutoff turns a dense structure
     into a web of lines that says nothing, while the short contact is exactly
     what distinguishes these phases - rutile VO2 has one V-V distance along the
     chain, and the monoclinic phases pair up into dimers. */
  function links(scene, A) {
    if (scene.kind !== "r") return { lines: [], dmin: null };
    const home = scene.points.filter(p => p.major);
    /* Neighbours are looked up over the surrounding cells. A dimer partner one
       translation away is still a nearest neighbour, and without the images the
       reported shortest contact is whatever happens to fall inside the box -
       2.62 A in VO2 M1 becomes 3.17 A, which is a different physical claim. */
    const images = [];
    for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) for (let w = -1; w <= 1; w++)
      for (const q of home) images.push({ p: [0, 1, 2].map(t => q.p[t] + u * A[0][t] + v * A[1][t] + w * A[2][t]) });
    const all = [];
    for (const a of home) for (const b of images) {
      const d = C.norm([0, 1, 2].map(t => a.p[t] - b.p[t]));
      if (d > 0.3 && d < 4.5) all.push({ a: a.p, b: b.p, d });
    }
    if (!all.length) return { lines: [], dmin: null };
    const dmin = Math.min.apply(null, all.map(x => x.d));
    return { lines: all.filter(x => x.d <= dmin * 1.15), dmin };
  }

  /* ---------- SVG ---------- */

  function draw() {
    const host = $("#pv-figure");
    host.textContent = "";
    const recs = chosenRecords();
    if (!recs.length) {
      host.appendChild(el("p", { class: "pv-empty", text: "왼쪽에서 구조를 선택하면 그림이 그려집니다." }));
      return;
    }
    const theme = state.paper ? "light" : "dark";
    const ink = state.paper ? "#111" : "#f5f5f7";
    const faint = state.paper ? "rgba(0,0,0,.30)" : "rgba(245,245,247,.30)";

    if (state.mode === "overlay") host.appendChild(overlayPanel(recs, theme, ink, faint));
    else {
      const grid = el("div", { class: "pv-grid" });
      recs.forEach((rec, k) => grid.appendChild(panel([{ rec, color: PANEL[theme], mark: 0 }], theme, ink, faint, titleOf(rec), 320)));
      host.appendChild(grid);
    }
  }

  const titleOf = rec => `${rec.spacegroup} · COD ${rec.id}${rec.temperature ? " · " + rec.temperature + " K" : ""}`;

  function overlayPanel(recs, theme, ink, faint) {
    const ref = recs[0];
    const refA = structure(ref).vectors;
    const layers = [{ rec: ref, color: SERIES[theme][0], mark: 0, frame: refA, P: null }];
    const notes = [];
    recs.slice(1).forEach((rec, k) => {
      const m = C.matchLattice(structure(ref).cell, structure(rec).cell, { maxIndex: 3, tol: 0.05 });
      if (!m) {
        notes.push({ rec, text: "기준 상과 정수 관계를 찾지 못했습니다 — 겹쳐 그리지 않습니다." });
        return;
      }
      layers.push({ rec, color: SERIES[theme][k + 1], mark: k + 1, frame: C.applyMatrix(m.P, refA), P: m });
    });
    const wrap = el("div", {});
    wrap.appendChild(panel(layers, theme, ink, faint, `기준 ${titleOf(ref)}`, 520));
    const list = el("div", { class: "pv-relation" });
    layers.slice(1).forEach(L => {
      const P = L.P.P.map(r => r.join(" ")).join(" / ");
      list.appendChild(el("p", {
        html: `<b style="color:${L.color}">${L.rec.spacegroup} · COD ${L.rec.id}</b> — 기준 격자 위에 올린 변환 <code>[${P}]</code>, 격자 어긋남 ${(L.P.misfit * 100).toFixed(2)} %, 부피비 ${L.P.det}×. <span class="pv-caveat">기하학적 일치를 찾은 것이며, 군·부분군 유도가 아닙니다.</span>`
      }));
    });
    notes.forEach(n => list.appendChild(el("p", { class: "pv-caveat", text: `${n.rec.spacegroup} · COD ${n.rec.id} — ${n.text}` })));
    wrap.appendChild(list);
    return wrap;
  }

  function panel(layers, theme, ink, faint, title, size) {
    const W = size, H = Math.round(size * 0.92);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pv-svg", width: W, height: H });
    svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: state.paper ? "#ffffff" : "none" }));

    const scenes = layers.map(L => ({ L, S: sceneFor(L.rec, L.frame) }));
    /* One scale for every layer in the panel: an overlay whose phases were
       scaled independently would show a relation that is not there. */
    let span = 0;
    scenes.forEach(({ S }) => {
      S.points.forEach(p => { span = Math.max(span, C.norm(p.p)); });
      cellEdges(S.basis).corner.forEach(c => { span = Math.max(span, C.norm(c)); });
    });
    const k = (Math.min(W, H) * 0.40) / (span || 1);
    const cx = W / 2, cy = H / 2 + 6;
    const to2 = p => { const r = rotate(p); return [cx + r[0] * k, cy - r[1] * k, r[2]]; };

    const g = el("g", {});
    scenes.forEach(({ L, S }) => {
      const dashed = layers.length > 1 && L.mark > 0;
      const E = cellEdges(S.basis);
      E.pairs.forEach(([i, j]) => {
        const a = to2(E.corner[i]), b = to2(E.corner[j]);
        g.appendChild(el("line", {
          x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: b[0].toFixed(1), y2: b[1].toFixed(1),
          stroke: layers.length > 1 ? L.color : faint, "stroke-width": dashed ? 1.3 : 1.8,
          "stroke-dasharray": dashed ? "5 4" : null, opacity: layers.length > 1 ? 0.9 : 1
        }));
      });
      if (S.kind === "r") {
        const lk = links(S, S.basis);
        S.dmin = lk.dmin;
        lk.lines.forEach(b => {
          const a = to2(b.a), c2 = to2(b.b);
          g.appendChild(el("line", { x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: c2[0].toFixed(1), y2: c2[1].toFixed(1), stroke: L.color, "stroke-width": 2.6, opacity: 0.85, "stroke-linecap": "round" }));
        });
      }
    });
    svg.appendChild(g);

    /* Painter's order across all layers together, so a point behind another
       phase is drawn behind it. */
    const marks = [];
    scenes.forEach(({ L, S }) => S.points.forEach(p => marks.push({ L, S, p, v: to2(p.p) })));
    marks.sort((a, b) => a.v[2] - b.v[2]);
    const mg = el("g", {});
    marks.forEach(({ L, S, p, v }) => {
      const r = S.kind === "q" ? p.r : p.r;
      const fill = S.kind === "r" && !p.major ? (state.paper ? "#9aa0a6" : "#7f8792") : L.color;
      const shape = MARKS[L.mark] || "circle";
      /* Phases that share a reflection position are the whole reason for the
         overlay, so the reference is an open ring and the others sit inside it;
         filled-over-filled would just hide whichever is drawn first. */
      if (layers.length > 1 && L.mark === 0 && S.kind === "q") {
        mg.appendChild(el("circle", { cx: v[0].toFixed(1), cy: v[1].toFixed(1), r: (r + 2.6).toFixed(1), fill: "none", stroke: L.color, "stroke-width": 1.8 }));
      } else if (shape === "square" && S.kind === "q")
        mg.appendChild(el("rect", { x: (v[0] - r).toFixed(1), y: (v[1] - r).toFixed(1), width: (2 * r).toFixed(1), height: (2 * r).toFixed(1), fill, stroke: state.paper ? "#fff" : "#050507", "stroke-width": 1 }));
      else if (shape === "triangle" && S.kind === "q")
        mg.appendChild(el("polygon", { points: `${v[0].toFixed(1)},${(v[1] - r * 1.2).toFixed(1)} ${(v[0] - r * 1.1).toFixed(1)},${(v[1] + r * 0.8).toFixed(1)} ${(v[0] + r * 1.1).toFixed(1)},${(v[1] + r * 0.8).toFixed(1)}`, fill, stroke: state.paper ? "#fff" : "#050507", "stroke-width": 1 }));
      else
        mg.appendChild(el("circle", { cx: v[0].toFixed(1), cy: v[1].toFixed(1), r: r.toFixed(1), fill, stroke: state.paper ? "#fff" : "#050507", "stroke-width": S.kind === "r" ? 1 : 0.8 }));
    });
    svg.appendChild(mg);

    /* At most four reflections are named, and only on the reference phase. A
       reciprocal map with a label on every point is unreadable; the labels are
       there to anchor the eye, not to index the pattern. */
    if (scenes[0].S.kind === "q") {
      const S = scenes[0].S, L = scenes[0].L;
      const lg = el("g", {});
      S.points.slice(0, 4).forEach(p => {
        const v = to2(p.p);
        lg.appendChild(el("text", {
          x: (v[0] + p.r + 3).toFixed(1), y: (v[1] - p.r - 1).toFixed(1),
          fill: layers.length > 1 ? L.color : ink, "font-size": 10.5,
          text: p.hkl.map(n => n < 0 ? Math.abs(n) + "\u0305" : String(n)).join("")
        }));
      });
      svg.appendChild(lg);
    }

    /* Axis triad of the panel's frame, drawn from the origin. */
    const B = scenes[0].S.basis;
    const names = scenes[0].S.kind === "q" ? ["a*", "b*", "c*"] : ["a", "b", "c"];
    const ag = el("g", {});
    const o = to2([0, 0, 0]);
    B.forEach((v, i) => {
      const t = to2(v.map(x => x * 0.9));
      ag.appendChild(el("line", { x1: o[0].toFixed(1), y1: o[1].toFixed(1), x2: t[0].toFixed(1), y2: t[1].toFixed(1), stroke: faint, "stroke-width": 1.4 }));
      ag.appendChild(el("text", { x: t[0].toFixed(1), y: t[1].toFixed(1), fill: ink, "font-size": 11, "font-style": "italic", dx: 3, dy: -2, text: names[i] }));
    });
    svg.appendChild(ag);

    if (title) svg.appendChild(el("text", { x: 10, y: 18, fill: ink, "font-size": 12, text: title }));
    /* The number the real-space panel exists to show. */
    const dmin = scenes[0].S.dmin;
    if (dmin) svg.appendChild(el("text", { x: 10, y: H - 10, fill: ink, "font-size": 11, opacity: 0.8,
      text: `최단 ${scenes[0].S.major}–${scenes[0].S.major} ${dmin.toFixed(3)} Å` }));
    if (layers.length > 1) {
      const lg = el("g", {});
      layers.forEach((L, i) => {
        lg.appendChild(el("circle", { cx: 16, cy: H - 16 - i * 16, r: 4.5, fill: L.color }));
        lg.appendChild(el("text", { x: 26, y: H - 12 - i * 16, fill: ink, "font-size": 11, text: `${L.rec.spacegroup} · COD ${L.rec.id}` }));
      });
      svg.appendChild(lg);
    }
    return svg;
  }

  /* ---------- page ---------- */

  function render() {
    const list = $("#pv-list");
    list.textContent = "";
    state.groups.forEach((g, i) => {
      const L = groupLabel(g);
      const on = state.chosen.includes(i);
      const row = el("div", { class: "pv-row" + (on ? " on" : "") });
      const box = el("input", { type: "checkbox", id: "pv-g" + i });
      if (on) box.setAttribute("checked", "checked");
      box.addEventListener("change", e => toggle(i, e.target.checked));
      const head = el("label", { for: "pv-g" + i, class: "pv-head" }, [
        el("span", { class: "pv-sg", text: L.head }),
        el("span", { class: "pv-cell", text: L.sub })
      ]);
      if (L.name) head.appendChild(el("span", { class: "pv-name", text: L.name }));
      row.appendChild(box); row.appendChild(head);
      if (g.length > 1) {
        const sel = el("select", { class: "pv-pick" });
        g.forEach((r, j) => {
          const o = el("option", { value: j, text: `COD ${r.id}${r.year ? " · " + r.year : ""}${r.temperature ? " · " + r.temperature + " K" : ""}` });
          if ((state.pick[i] || 0) === j) o.setAttribute("selected", "selected");
          sel.appendChild(o);
        });
        sel.addEventListener("change", e => { state.pick[i] = +e.target.value; draw(); });
        row.appendChild(sel);
        row.appendChild(el("span", { class: "pv-multi", text: `같은 구조를 보고한 논문 ${g.length}건` }));
      } else {
        row.appendChild(el("a", { class: "pv-link", href: g[0].url, target: "_blank", rel: "noreferrer", text: `COD ${g[0].id} ↗` }));
      }
      list.appendChild(row);
    });
    $("#pv-count").textContent = `${state.chosen.length} / ${state.mode === "overlay" ? MAX_OVERLAY : MAX_PANELS}`;
    draw();
  }

  function exportSvg() {
    const svg = $("#pv-figure svg");
    if (!svg) return;
    const copy = svg.cloneNode(true);
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + copy.outerHTML], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.formula || "phases"}-${state.view}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function wire() {
    $("#pv-form").addEventListener("submit", e => { e.preventDefault(); loadFormula($("#pv-input").value); });
    document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => {
      state.view = b.dataset.view;
      document.querySelectorAll("[data-view]").forEach(x => x.classList.toggle("on", x === b));
      draw();
    }));
    document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("on", x === b));
      if (state.mode === "overlay" && state.chosen.length > MAX_OVERLAY) {
        state.chosen = state.chosen.slice(0, MAX_OVERLAY);
        status(`겹쳐보기는 ${MAX_OVERLAY}개까지라 앞의 ${MAX_OVERLAY}개만 남겼습니다.`, true);
      }
      render();
    }));
    $("#pv-paper").addEventListener("click", () => {
      state.paper = !state.paper;
      $("#pv-paper").classList.toggle("on", state.paper);
      $("#pv-figure").classList.toggle("paper", state.paper);
      draw();
    });
    $("#pv-reset").addEventListener("click", () => { state.yaw = -0.62; state.pitch = -0.42; draw(); });
    $("#pv-svg").addEventListener("click", exportSvg);
    /* Drag to turn the model; the figure is three-dimensional and a fixed view
       hides whichever relation happens to be edge-on. */
    let drag = null;
    $("#pv-figure").addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch }; });
    window.addEventListener("pointerup", () => { drag = null; });
    window.addEventListener("pointermove", e => {
      if (!drag) return;
      state.yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
      state.pitch = Math.max(-1.4, Math.min(1.4, drag.pitch - (e.clientY - drag.y) * 0.008));
      draw();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    wire();
    try {
      const r = await fetch("data/phases/index.json", { cache: "no-store" });
      window.PHASE_INDEX = r.ok ? await r.json() : [];
    } catch (e) { window.PHASE_INDEX = []; }
    const hint = $("#pv-have");
    hint.textContent = (window.PHASE_INDEX || []).map(x => x.formula).join(" · ");
    const start = new URLSearchParams(location.search).get("f") || (window.PHASE_INDEX[0] || {}).formula;
    if (start) { $("#pv-input").value = start; loadFormula(start); }
  });
})();
