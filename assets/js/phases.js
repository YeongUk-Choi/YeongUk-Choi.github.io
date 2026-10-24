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
  /* Space groups, mineral names and record URLs are database text, and once a
     live COD relay is wired in they are remote text this page did not write.
     Nothing from a record is ever handed to the HTML parser: el() has no html
     branch, and a URL is only made a link if it is http(s). */
  const safeUrl = u => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);
  /* The namespace is chosen from the SVG side, not the HTML side. An HTML
     allow-list silently puts anything it forgot into the SVG namespace, where
     it parses but renders nothing: <b> and <code> inside a <p> disappeared
     that way. Everything the figure draws is listed here; everything else is
     HTML. */
  const SVG_TAGS = new Set(["svg", "g", "rect", "line", "circle", "polygon", "polyline", "path", "text", "tspan", "defs", "marker", "ellipse", "title"]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, kids) => {
    const n = document.createElementNS(SVG_TAGS.has(tag) ? SVG_NS : "http://www.w3.org/1999/xhtml", tag);
    for (const k in (attrs || {})) {
      if (k === "text") n.textContent = attrs[k];
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
    formula: "", sg: null, data: null, groups: [], pick: {}, chosen: [],
    view: "reciprocal", mode: "panels", paper: false, section: "",
    yaw: -0.62, pitch: -0.42, qmax: 0.55, topN: 24, ref: 0
  };

  /* ---------- data ----------

     Two sources, in this order:
       1. data/phases/<formula>.json, committed by scripts/fetch_phases.py.
          Instant, works while COD is down, no quota.
       2. the Apps Script relay, for a composition nobody fetched in advance.
          COD sends no Access-Control-Allow-Origin header, so the browser
          cannot call it directly; the contract is in COD_PROXY.md.

     The relay is off until the new Apps Script is deployed and checked - see
     data/phases.js for why turning it on early would lock the helium log. */

  const relay = () => {
    const cfg = (window.SITE && window.SITE.phases) || {};
    return cfg.live && cfg.relayUrl ? String(cfg.relayUrl) : null;
  };

  /* A COD search row and a cached entry describe the same thing in different
     words. Everything the viewer compares arithmetically is made a number
     here: COD sends "9.083", and a string cell silently breaks lattice
     grouping - every record would become its own candidate.

     An absent value stays absent. Number(null) and Number("") are both 0, so
     coercing first would turn "this record does not say" into "this record
     says zero" - a space group number COD never assigns, read as one it
     did. */
  const num = v => {
    if (v == null || (typeof v === "string" && !v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  function fromCodRow(r) {
    const e = {
      cod_id: String(r.file), formula: r.formula, spacegroup: r.sg || "?", sg_number: num(r.sgNumber),
      a: num(r.a), b: num(r.b), c: num(r.c),
      alpha: num(r.alpha), beta: num(r.beta), gamma: num(r.gamma), volume: num(r.vol),
      temperature: num(r.celltemp), title: r.title || "", authors: r.authors || "",
      journal: r.journal || "", year: num(r.year), doi: r.doi || "",
      mineral: r.mineral || "", chemname: r.chemname || "",
      url: `https://www.crystallography.net/cod/${encodeURIComponent(String(r.file))}.html`,
      cif: null                              /* fetched only when it is drawn */
    };
    return e;
  }

  /* A COD row with no cell cannot be grouped or drawn, and a row with no
     space group number cannot be shown to carry the number that was asked
     for. Neither kind is thrown away on arrival: a search that ends with
     nothing on screen has to be able to say which of the two happened, or
     "we cannot draw it" is read as "COD does not have it". */
  const hasCell = e => [e.a, e.b, e.c, e.alpha, e.beta, e.gamma].every(v => v != null && v > 0);
  const sgKnown = e => Number.isFinite(e.sg_number) && e.sg_number >= 1 && e.sg_number <= 230;

  async function relaySearch(name, sg) {
    const q = `action=cod&formula=${encodeURIComponent(name)}` + (sg == null ? "" : `&sg=${sg}`);
    const r = await fetch(`${relay()}?${q}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`중계 서버가 HTTP ${r.status}을 돌려주었습니다`);
    const j = await r.json();
    if (!j || j.ok !== true) throw new Error((j && j.error) || "중계 서버가 오류를 돌려주었습니다");
    return { formula: j.formula || name, fetched: (j.fetched_at || "").slice(0, 10),
      source: "COD (relay)", cached: !!j.cached, entries: (j.records || []).map(fromCodRow) };
  }

  /* Only the newest search may write. Two searches are in flight whenever the
     reader types a second one before the first answers, and the answers can
     arrive in either order: a cached relay reply comes back in milliseconds
     and a cold one takes seconds. Without this, an older answer lands on top
     of a newer one while the composition and number on screen - and in the
     exported file name - still belong to the newer one. */
  let searchSeq = 0;

  /* The two inputs are a composition and, optionally, a space group number.
     The number is only ever a filter on records; it never changes what is
     drawn. The relay passes it to COD so a large search can be narrowed
     upstream, and it is applied again here, because COD answers an
     out-of-range or unparsable space_group_number with the unfiltered search
     rather than with an error. Filtering only upstream would therefore show
     every phase under a heading that says one. */
  async function loadFormula(text, sgText) {
    const name = String(text || "").trim().replace(/\s+/g, "");
    if (!name) return;
    const sg = C.sgNumber(sgText);
    if (Number.isNaN(sg)) {
      status("공간군 번호는 1부터 230까지의 정수입니다. 비워 두면 그 조성의 전부를 찾습니다.", true);
      return;                              /* the figure on screen is left alone */
    }
    const seq = ++searchSeq;
    const mine = () => seq === searchSeq;
    /* The search this page says it is showing is set together with the
       records it is showing, never before them. */
    const commit = d => { state.formula = name; state.sg = sg; state.data = d; };
    status(sg == null ? "COD 캐시를 읽는 중…" : `COD 캐시를 읽는 중… (공간군 ${sg}번)`);
    let live = false, data = null;
    try {
      const r = await fetch(`data/phases/${encodeURIComponent(name)}.json`, { cache: "no-store" });
      if (!mine()) return;
      if (!r.ok) throw new Error("not cached");
      data = await r.json();
      if (!mine()) return;
    } catch (e) {
      if (!mine()) return;
      data = null;
      if (relay()) {
        status(`받아 둔 조성이 아니어서 COD에 직접 물어보는 중… (‘${name}’${sg == null ? "" : `, 공간군 ${sg}번`})`);
        let err = null;
        try { data = await relaySearch(name, sg); live = true; }
        catch (e2) { data = null; err = e2; }
        if (!mine()) return;
        if (err) status(`COD 검색이 되지 않았습니다 — ${err.message}`, true);
      }
      if (!data) {
        commit(null);
        state.groups = []; state.chosen = []; state.pick = {};
        render();
        if (!relay()) {
          const have = (window.PHASE_INDEX || []).map(x => x.formula);
          status(`‘${name}’은(는) 아직 이 사이트에 받아 둔 조성이 아닙니다. 지금 있는 것: ${have.join(", ") || "없음"}`, true);
        }
        return;
      }
    }
    commit(data);
    /* Four counts, because they answer four different questions: what the
       search returned, how much of it carries the requested number, how much
       of that can be drawn, and how much could not be judged at all. Rolling
       the last two into the first turns "COD has it but we cannot use it"
       into "COD does not have it". */
    const found = data.entries || [];
    const matched = C.filterBySg(found, sg);
    const drawable = matched.filter(hasCell);
    const noCell = matched.length - drawable.length;
    const unknown = sg == null ? 0 : found.filter(e => !sgKnown(e)).length;
    /* One COD record is one publication, not one phase. Group first, then let
       the reader choose which record of a phase to draw. */
    const recs = drawable.map(e => Object.assign({ id: String(e.cod_id), sgNumber: e.sg_number, cell: e }, e));
    state.groups = C.groupPhases(recs);
    state.pick = {}; state.chosen = []; state.ref = 0;
    state.groups.forEach((g, i) => { state.pick[i] = 0; });
    /* Candidates, not phases: grouping agrees on the lattice metric to a
       tolerance, which is evidence and not proof that two records are the
       same phase. */
    const where = live
      ? `COD 즉석 검색${data.cached ? " (중계 캐시)" : ""}`
      : `받아 둔 날짜 ${data.fetched}`;
    const notes = (noCell ? `, 격자값이 없어 그릴 수 없는 레코드 ${noCell}건` : "")
      + (unknown ? `, 공간군 번호가 없어 확인하지 못한 레코드 ${unknown}건` : "");
    /* Where the filter was applied decides what the count can honestly say.
       The committed cache holds the whole composition, so it can report "N of
       M"; a relayed search was already narrowed at COD, so the records that
       did not match were never sent and cannot be counted here. */
    const upstream = live && sg != null;
    /* An empty result of a filter is a finding, not a failure: it says the
       database has this composition but not under that number. It says that
       only when the records were actually judged - a record held back for a
       missing cell or a missing number is reported as such instead. */
    if (sg != null && !recs.length) {
      const seen = Array.from(new Set(found.filter(sgKnown).map(e => e.sg_number))).sort((x, y) => x - y);
      const head = matched.length
        ? `‘${name}’에 공간군 ${sg}번 COD 레코드 ${matched.length}건이 있지만, 격자값이 없어 그릴 수 없습니다`
        : upstream
          ? `‘${name}’에 공간군 ${sg}번으로 등록된 COD 레코드가 없습니다`
          : `‘${name}’ 레코드 ${found.length}건 중 공간군 ${sg}번은 없습니다`
            + (seen.length ? ` — 이 조성에 있는 번호: ${seen.join(", ")}` : "");
      status(`${head} (${where})`
        + (unknown ? ` 공간군 번호가 비어 있어 확인하지 못한 레코드가 ${unknown}건 있습니다.` : ""), true);
      render();
      return;
    }
    const picked = sg == null ? `COD 레코드 ${recs.length}건`
      : upstream ? `공간군 ${sg}번 COD 레코드 ${recs.length}건`
      : `COD 레코드 ${found.length}건 중 공간군 ${sg}번 ${recs.length}건`;
    status(`${picked} → 유사 격자 후보 ${state.groups.length}개 (${where}${notes})`);
    render();
  }

  /* The search gives a lattice; the drawing needs atoms, which live in the
     CIF. Over the relay that is one request per record, so a CIF is fetched
     when its box is ticked rather than all of them up front. */
  async function fetchCif(rec) {
    if (rec.cif) return null;
    if (!relay()) return "이 레코드에는 CIF가 들어 있지 않습니다";
    try {
      const r = await fetch(`${relay()}?action=cif&id=${encodeURIComponent(rec.id)}`, { cache: "no-store" });
      const text = await r.text();
      /* The relay answers a failure with JSON and a success with the CIF
         itself, so the body decides which one arrived. */
      if (!r.ok || /^\s*\{/.test(text)) {
        let msg = `HTTP ${r.status}`;
        try { const j = JSON.parse(text); if (j && j.error) msg = j.error; } catch (e) { /* keep the status */ }
        return `COD ${rec.id}의 CIF를 받지 못했습니다 — ${msg}`;
      }
      rec.cif = text;
      return null;
    } catch (e) {
      return `COD ${rec.id}의 CIF를 받지 못했습니다 — ${e.message}`;
    }
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
      let p = null, problem = null;
      try {
        p = C.parseCif(rec.cif || "");
        problem = C.structureProblem(p);
        if (!problem) {
          p.atoms = C.expandAtoms(p.atoms, p.symops);
          p.vectors = C.cellVectors(p.cell);
        }
      } catch (e) {
        problem = "CIF를 읽는 중 오류가 났습니다" + (e && e.message ? ` (${e.message})` : "");
      }
      cache.set(rec.id, problem ? { problem } : p);
    }
    return cache.get(rec.id);
  }
  /* A record whose CIF has not arrived yet is not a failure - it is simply not
     drawable yet, and must not be run through the parser. */
  const pending = rec => !rec.cif;
  /* A record this reader cannot follow is shown as a failed candidate and kept
     out of every figure. Drawing half of it would be worse than not drawing
     it: a cell with one missing length still renders a box. */
  const problemOf = rec => (pending(rec) ? null : structure(rec).problem || null);

  const recordOf = i => state.groups[i][state.pick[i] || 0];
  const chosenRecords = () => state.chosen.map(recordOf);

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

  async function toggle(i, on) {
    const cap = state.mode === "overlay" ? MAX_OVERLAY : MAX_PANELS;
    if (on) {
      if (state.chosen.includes(i)) return;
      const rec = recordOf(i);
      /* The cap is checked before the request, so a refused pick costs COD
         nothing. */
      if (state.chosen.length >= cap) {
        status(state.mode === "overlay"
          ? `겹쳐보기는 ${MAX_OVERLAY}개까지입니다. 네 번째 색은 색각 이상에서 구분되지 않아 넣지 않습니다 — 나란히 보기로 바꾸면 ${MAX_PANELS}개까지 됩니다.`
          : `나란히 보기는 ${MAX_PANELS}개까지입니다.`, true);
        render(); return;
      }
      if (pending(rec)) {
        status(`COD ${rec.id}의 CIF를 받는 중…`);
        /* A tick is an index into the current candidate list, and a search
           that finishes while the CIF is on its way builds a new one: the
           same index would then tick a different phase. */
        const seq = searchSeq;
        const err = await fetchCif(rec);
        if (seq !== searchSeq) return;     /* the new search cleared the ticks */
        if (err) { status(err, true); render(); return; }
        status("");
      }
      const bad = problemOf(rec);
      if (bad) { status(`이 레코드는 그릴 수 없습니다 — ${bad}`, true); render(); return; }
      if (state.chosen.includes(i) || state.chosen.length >= cap) { render(); return; }
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

  /* A reciprocal-space section: the zero layer of a zone, drawn flat, the way
     a reciprocal-space map is read. The plane is spanned by two of the
     reference phase's reciprocal axes and passes through the origin, so hk0 is
     a* with b*. Overlaid phases are already expressed in the reference frame,
     so one plane serves every layer - which is the point: it shows which
     reflections of the other phases actually fall in the zone, not which ones
     happen to project near it from somewhere else in the sphere. */
  const SECTIONS = {
    "hk0": { axes: [0, 1], names: ["a*", "b*"], label: "hk0" },
    "h0l": { axes: [0, 2], names: ["a*", "c*"], label: "h0l" },
    "0kl": { axes: [1, 2], names: ["b*", "c*"], label: "0kl" }
  };
  /* Half-thickness of the slab, in 1/A. A phase overlaid with a 1 % lattice
     misfit sits a few thousandths off the reference plane; anything much
     thicker starts admitting the next layer up. */
  const SLAB = 0.02;
  const sectionOn = () => !!(state.section && state.view === "reciprocal" && SECTIONS[state.section]);

  function sectionFrame(B) {
    const [i, j] = SECTIONS[state.section].axes;
    const u = B[i], v = B[j];
    const e1 = C.norm(u) ? u.map(x => x / C.norm(u)) : [1, 0, 0];
    const vp = v.map((x, t) => x - C.dot(v, e1) * e1[t]);
    const e2 = C.norm(vp) ? vp.map(x => x / C.norm(vp)) : [0, 1, 0];
    const n = C.cross(e1, e2);
    return { e1, e2, n, names: SECTIONS[state.section].names };
  }

  /* Everything a panel draws, in one Cartesian frame, before projection. */
  function sceneFor(rec, frame) {
    const st = structure(rec);
    const A = frame || st.vectors;
    if (state.view === "reciprocal") {
      /* Reflections come back strongest first. A monoclinic cell four times the
         rutile volume has four times the reciprocal points, so drawing every
         one of them inside the same sphere buries the small cell and the figure
         stops carrying a message. Each phase contributes its strongest few. */
      /* A section throws most of the sphere away, so the cut is made on a
         deep list and trimmed to topN afterwards; trimming first would leave a
         near-empty plane. */
      const refl = C.reflections(A, st.atoms, { qmax: state.qmax, maxIndex: 5 }).slice(0, sectionOn() ? 600 : state.topN);
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

  /* Controls that only make sense in one view are disabled rather than left
     looking as if they did something. Done in one place, because the section
     and the view can each be changed from the other's handler. */
  function syncControls() {
    const flat = sectionOn();
    $("#pv-section").disabled = state.view !== "reciprocal";
    $("#pv-reset").disabled = flat;
    $("#pv-figure").classList.toggle("flat", flat);
  }

  function draw() {
    syncControls();
    const host = $("#pv-figure");
    host.textContent = "";
    const recs = chosenRecords().filter(r => !pending(r) && !problemOf(r));
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
      const line = el("p", {}, [
        el("b", { style: `color:${L.color}`, text: `${L.rec.spacegroup} · COD ${L.rec.id}` }),
        el("span", { text: " — 기준 격자 위에 올린 변환 " }),
        el("code", { text: `[${P}]` }),
        el("span", { text: `, 격자 어긋남 ${(L.P.misfit * 100).toFixed(2)} %, 부피비 ${L.P.det}×. ` }),
        el("span", { class: "pv-caveat", text: "기하학적 일치를 찾은 것이며, 군·부분군 유도가 아닙니다." })
      ]);
      list.appendChild(line);
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

    /* In a section the figure is flat, so the model rotation is not applied:
       the plane is drawn face on, which is the only view in which distances
       inside it are true. */
    const cut = sectionOn() && scenes[0].S.kind === "q" ? sectionFrame(scenes[0].S.basis) : null;
    if (cut) scenes.forEach(({ S }) => {
      S.points = S.points.filter(p => Math.abs(C.dot(p.p, cut.n)) <= SLAB).slice(0, state.topN);
    });
    const proj = cut ? (p => [C.dot(p, cut.e1), C.dot(p, cut.e2), 0]) : rotate;

    /* One scale for every layer in the panel: an overlay whose phases were
       scaled independently would show a relation that is not there. */
    let span = 0;
    scenes.forEach(({ S }) => {
      /* Out of section the extent is measured in three dimensions so that the
         figure does not breathe while it is being dragged. */
      S.points.forEach(p => { const q = proj(p.p); span = Math.max(span, cut ? Math.hypot(q[0], q[1]) : C.norm(p.p)); });
      if (!cut) cellEdges(S.basis).corner.forEach(c => { span = Math.max(span, C.norm(c)); });
    });
    const k = (Math.min(W, H) * 0.40) / (span || 1);
    const cx = W / 2, cy = H / 2 + 6;
    const to2 = p => { const r = proj(p); return [cx + r[0] * k, cy - r[1] * k, r[2]]; };

    const g = el("g", {});
    scenes.forEach(({ L, S }) => {
      const dashed = layers.length > 1 && L.mark > 0;
      const E = cellEdges(S.basis);
      if (!cut) E.pairs.forEach(([i, j]) => {
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
    const B0 = scenes[0].S.basis;
    const B = cut ? SECTIONS[state.section].axes.map(i => B0[i]) : B0;
    const names = cut ? cut.names : (scenes[0].S.kind === "q" ? ["a*", "b*", "c*"] : ["a", "b", "c"]);
    const ag = el("g", {});
    const o = to2([0, 0, 0]);
    B.forEach((v, i) => {
      const t = to2(v.map(x => x * 0.9));
      ag.appendChild(el("line", { x1: o[0].toFixed(1), y1: o[1].toFixed(1), x2: t[0].toFixed(1), y2: t[1].toFixed(1), stroke: faint, "stroke-width": 1.4 }));
      ag.appendChild(el("text", { x: t[0].toFixed(1), y: t[1].toFixed(1), fill: ink, "font-size": 11, "font-style": "italic", dx: 3, dy: -2, text: names[i] }));
    });
    svg.appendChild(ag);

    if (title) svg.appendChild(el("text", { x: 10, y: 18, fill: ink, "font-size": 12, text: title }));
    if (cut) svg.appendChild(el("text", { x: 10, y: 33, fill: ink, "font-size": 10.5, opacity: 0.75,
      text: `${SECTIONS[state.section].label} 단면 · 면에서 ±${SLAB} Å⁻¹ 안의 반사만` }));
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
      const rec = recordOf(i);
      const bad = problemOf(rec);
      if (bad) state.chosen = state.chosen.filter(x => x !== i);
      const on = state.chosen.includes(i);
      const row = el("div", { class: "pv-row" + (on ? " on" : "") + (bad ? " bad" : "") });
      const box = el("input", { type: "checkbox", id: "pv-g" + i });
      if (on) box.setAttribute("checked", "checked");
      if (bad) { box.disabled = true; box.setAttribute("disabled", "disabled"); }
      box.addEventListener("change", e => toggle(i, e.target.checked));
      const head = el("label", { for: "pv-g" + i, class: "pv-head" }, [
        el("span", { class: "pv-sg", text: L.head }),
        el("span", { class: "pv-cell", text: L.sub })
      ]);
      if (L.name) head.appendChild(el("span", { class: "pv-name", text: L.name }));
      row.appendChild(box); row.appendChild(head);
      /* A record the parser could not follow is named and kept out of the
         figure, rather than drawn from whatever fields happened to survive. */
      if (bad) row.appendChild(el("span", { class: "pv-bad", text: `그리기 실패 — ${bad}` }));
      if (g.length > 1) {
        const sel = el("select", { class: "pv-pick" });
        g.forEach((r, j) => {
          const o = el("option", { value: j, text: `COD ${r.id}${r.year ? " · " + r.year : ""}${r.temperature ? " · " + r.temperature + " K" : ""}` });
          if ((state.pick[i] || 0) === j) o.setAttribute("selected", "selected");
          sel.appendChild(o);
        });
        /* Re-render, not just redraw: another report of the same phase may be
           one the parser cannot read, and the row has to say so. Over the
           relay it may also be one whose CIF has not been fetched yet, and a
           chosen row must not quietly drop out of the figure. */
        sel.addEventListener("change", async e => {
          state.pick[i] = +e.target.value;
          const rec = recordOf(i);
          if (state.chosen.includes(i) && pending(rec)) {
            status(`COD ${rec.id}의 CIF를 받는 중…`);
            const err = await fetchCif(rec);
            if (err) { state.chosen = state.chosen.filter(x => x !== i); status(err, true); }
            else status("");
          }
          render();
        });
        row.appendChild(sel);
        row.appendChild(el("span", { class: "pv-multi", text: `같은 구조를 보고한 논문 ${g.length}건` }));
      } else {
        const href = safeUrl(g[0].url);
        row.appendChild(href
          ? el("a", { class: "pv-link", href, target: "_blank", rel: "noreferrer", text: `COD ${g[0].id} ↗` })
          : el("span", { class: "pv-link", text: `COD ${g[0].id}` }));
      }
      list.appendChild(row);
    });
    $("#pv-count").textContent = `${state.chosen.length} / ${state.mode === "overlay" ? MAX_OVERLAY : MAX_PANELS}`;
    draw();
  }

  /* ---------- export ----------

     Both exports go through one composite: a panel grid is several <svg>
     elements, and saving only the first - which is what a querySelector would
     do - silently drops every phase but one. The page font is written onto the
     exported root because the stylesheet does not travel with the file, and
     the background is painted in because the dark figure draws on the page,
     not on itself. */

  const EXPORT_FONT = "-apple-system, 'Apple SD Gothic Neo', 'Segoe UI', Helvetica, Arial, sans-serif";

  function composite() {
    const svgs = Array.from(document.querySelectorAll("#pv-figure svg"));
    if (!svgs.length) return null;
    const box = svgs.map(n => n.getBoundingClientRect());
    const minX = Math.min.apply(null, box.map(b => b.left));
    const minY = Math.min.apply(null, box.map(b => b.top));
    const W = Math.ceil(Math.max.apply(null, box.map(b => b.right)) - minX) + 16;
    const H = Math.ceil(Math.max.apply(null, box.map(b => b.bottom)) - minY) + 16;
    const parts = svgs.map((n, i) => {
      const c = n.cloneNode(true);
      c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      c.setAttribute("x", (box[i].left - minX + 8).toFixed(1));
      c.setAttribute("y", (box[i].top - minY + 8).toFixed(1));
      c.setAttribute("width", box[i].width.toFixed(1));
      c.setAttribute("height", box[i].height.toFixed(1));
      return c.outerHTML;
    });
    const bg = state.paper ? "#ffffff" : "#050507";
    return {
      W, H,
      markup: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${EXPORT_FONT}">`
        + `<rect width="${W}" height="${H}" fill="${bg}"/>${parts.join("")}</svg>`
    };
  }

  /* The file name carries the query, filter included: two exports of the same
     composition under different space group numbers are different figures. */
  const baseName = () => `${state.formula || "phases"}${state.sg ? "-sg" + state.sg : ""}-${state.view}${sectionOn() ? "-" + state.section : ""}`;

  function save(blob, ext) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName()}.${ext}`;
    a.click();
    /* The object URL is released after the click has been dispatched, not in
       the same statement: the browser reads the blob when it starts the
       download, and revoking inside the same task has been known to race it. */
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  }

  function exportSvg() {
    const c = composite();
    if (!c) return;
    save(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + c.markup], { type: "image/svg+xml" }), "svg");
  }

  function exportPng() {
    const c = composite();
    if (!c) return;
    const scale = 2;                       /* a figure for a slide or a paper */
    const url = URL.createObjectURL(new Blob([c.markup], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = c.W * scale; cv.height = c.H * scale;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = state.paper ? "#ffffff" : "#050507";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(b => { if (b) save(b, "png"); else status("PNG를 만들지 못했습니다 — SVG 저장을 쓰십시오.", true); }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); status("PNG를 만들지 못했습니다 — SVG 저장을 쓰십시오.", true); };
    img.src = url;
  }

  function wire() {
    $("#pv-form").addEventListener("submit", e => {
      e.preventDefault();
      loadFormula($("#pv-input").value, $("#pv-sg").value);
    });
    document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => {
      state.view = b.dataset.view;
      document.querySelectorAll("[data-view]").forEach(x => x.classList.toggle("on", x === b));
      /* A section is a cut through the reciprocal lattice; there is nothing to
         cut in the real-space view, so the control is shown as unavailable
         rather than left looking as if it did something. */
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
    $("#pv-png").addEventListener("click", exportPng);
    $("#pv-section").addEventListener("change", e => { state.section = e.target.value; draw(); });
    /* Drag to turn the model; the figure is three-dimensional and a fixed view
       hides whichever relation happens to be edge-on. */
    let drag = null;
    $("#pv-figure").addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch }; });
    window.addEventListener("pointerup", () => { drag = null; });
    window.addEventListener("pointermove", e => {
      if (!drag || sectionOn()) return;   /* a section is drawn face on */
      state.yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
      state.pitch = Math.max(-1.4, Math.min(1.4, drag.pitch - (e.clientY - drag.y) * 0.008));
      draw();
    });
  }

  /* The page starts the viewer, not the parser. With the lab-code gate on
     (data/phases.js), nothing is fetched until the code has been accepted -
     not the local index, and in particular not COD through the relay, whose
     quota belongs to the lab's helium log as well. */
  let running = false;
  async function start() {
    if (running) return;
    running = true;
    wire();
    try {
      const r = await fetch("data/phases/index.json", { cache: "no-store" });
      window.PHASE_INDEX = r.ok ? await r.json() : [];
    } catch (e) { window.PHASE_INDEX = []; }
    const hint = $("#pv-have");
    hint.textContent = (window.PHASE_INDEX || []).map(x => x.formula).join(" · ");
    const q = new URLSearchParams(location.search);
    const first = q.get("f") || (window.PHASE_INDEX[0] || {}).formula;
    const sg = q.get("sg") || "";
    if (first) {
      $("#pv-input").value = first;
      $("#pv-sg").value = sg;
      loadFormula(first, sg);
    }
  }
  window.PhaseViewer = { start };

  document.addEventListener("DOMContentLoaded", () => {
    if (!((window.SITE && window.SITE.phases) || {}).gate) start();
  });
})();
