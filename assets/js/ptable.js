/* Periodic table of materials. Grey map of every material; the selected one glows violet→orange.
   Rules (2026-09-21): tabs by family, default VO₂, dopants dashed, abbreviations large / formula small. */
(function () {
  const S = window.SITE || {}; const MATS = S.materials || []; const FAMS = S.families || [];
  const SYMS = ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr " +
    "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu " +
    "Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr " +
    "Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" ");
  // position: row (1-based, 9/10 = f-block rows), col (1-18)
  function pos(z) {
    if (z === 1) return [1, 1]; if (z === 2) return [1, 18];
    if (z <= 4) return [2, z - 2]; if (z <= 10) return [2, z + 8];
    if (z <= 12) return [3, z - 10]; if (z <= 18) return [3, z];
    if (z <= 36) return [4, z - 18]; if (z <= 54) return [5, z - 36];
    if (z <= 56) return [6, z - 54]; if (z <= 71) return [9, z - 57 + 3]; if (z <= 86) return [6, z - 68];
    if (z <= 88) return [7, z - 86]; if (z <= 103) return [10, z - 89 + 3]; return [7, z - 100];
  }
  const ELEMENTS = SYMS.map((s, i) => { const [r, c] = pos(i + 1); return { s, z: i + 1, r, c }; });
  const BY = Object.fromEntries(ELEMENTS.map(e => [e.s, e]));

  const CELL = 44, GAP = 4, PAD = 12, TOP = 12;
  const W = PAD * 2 + 18 * CELL + 17 * GAP, H = TOP + PAD + 10 * (CELL + GAP) + 6;
  const cx = e => PAD + (e.c - 1) * (CELL + GAP) + CELL / 2;
  const cy = e => TOP + (e.r - 1) * (CELL + GAP) + CELL / 2 + (e.r >= 9 ? 10 : 0);

  const used = new Set(); MATS.forEach(m => { m.elements.forEach(s => used.add(s)); (m.dopants || []).forEach(s => used.add(s)); });
  let family = "all", selected = (MATS.find(m => m.now) || MATS[0] || {}).id;
  const hash = decodeURIComponent(location.hash.slice(1)); if (hash && MATS.some(m => m.id === hash)) selected = hash;

  const NS = "http://www.w3.org/2000/svg";
  const mk = (t, a) => { const n = document.createElementNS(NS, t); for (const k in a) n.setAttribute(k, a[k]); return n; };

  function pathFor(m) {
    const pts = m.elements.map(s => BY[s]).filter(Boolean);
    return pts.map((e, i) => (i ? "L" : "M") + cx(e) + " " + cy(e)).join(" ");
  }
  function build() {
    const svg = document.getElementById("ptable");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `<defs>
      <linearGradient id="bondGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0">
        <stop offset="0" stop-color="#c084fc"/><stop offset="1" stop-color="#fb923c"/></linearGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
    const gCells = mk("g", {}), gBonds = mk("g", {}), gLit = mk("g", {}), gSyms = mk("g", {});
    ELEMENTS.forEach(e => {
      const x = cx(e) - CELL / 2, y = cy(e) - CELL / 2;
      gCells.append(mk("rect", { x, y, width: CELL, height: CELL, rx: 7, class: "cell" + (used.has(e.s) ? " used" : "") }));
      if (used.has(e.s)) gCells.append(mk("circle", { cx: cx(e), cy: cy(e), r: CELL / 2 - 5, class: "ring" }));
      const t = mk("text", { x: cx(e), y: cy(e), class: "sym" + (used.has(e.s) ? " used" : ""), "font-size": used.has(e.s) ? 15 : 12, "data-sym": e.s });
      t.textContent = e.s; gSyms.append(t);
    });
    MATS.forEach(m => {
      const d = pathFor(m);
      gBonds.append(mk("path", { d, class: "bond", "data-id": m.id }));
      (m.dopants || []).forEach(dp => { const a = BY[dp], b = BY[m.elements[0]]; gBonds.append(mk("path", { d: `M${cx(a)} ${cy(a)} L${cx(b)} ${cy(b)}`, class: "bond dop", "data-id": m.id, "data-dop": "1" })); });
      const hit = mk("path", { d, class: "bond-hit", "data-id": m.id }); hit.addEventListener("click", () => select(m.id)); gBonds.append(hit);
    });
    svg.append(gCells, gBonds, gLit, gSyms);
    svg._lit = gLit;
  }
  function renderTabs() {
    const box = document.getElementById("tabs"); box.innerHTML = "";
    FAMS.forEach(f => {
      const n = f.id === "all" ? MATS.length : MATS.filter(m => m.family === f.id).length;
      const b = document.createElement("button"); b.className = "tab" + (f.id === family ? " active" : ""); b.innerHTML = `${f.label}<span class="n">${n}</span>`;
      b.addEventListener("click", () => { family = f.id; const vis = visible(); if (!vis.some(m => m.id === selected)) selected = (vis.find(m => m.now) || vis[0]).id; update(); });
      box.append(b);
    });
  }
  function visible() { return family === "all" ? MATS : MATS.filter(m => m.family === family); }
  function renderChips() {
    const box = document.getElementById("chips"); box.innerHTML = "";
    FAMS.filter(f => f.id !== "all").forEach(f => {
      const ms = MATS.filter(m => m.family === f.id); if (!ms.length) return;
      const h = document.createElement("div"); h.className = "fam"; h.textContent = f.label; box.append(h);
      ms.forEach(m => {
        const b = document.createElement("button"); b.className = "chip" + (m.id === selected ? " active" : "") + (family !== "all" && m.family !== family ? " dim" : "");
        b.innerHTML = `<span><span class="lbl">${m.label}</span>${m.abbr && m.chipFormula !== false ? `<div class="frm">${m.formula}</div>` : ""}</span>${m.now ? '<span class="now">now</span>' : ""}`;
        b.addEventListener("click", () => select(m.id)); box.append(b);
      });
    });
  }
  function renderDetail() {
    const m = MATS.find(x => x.id === selected); const d = document.getElementById("detail"); if (!m) return;
    const fam = FAMS.find(f => f.id === m.family) || {};
    d.innerHTML = `<div><div class="eyebrow">${fam.label || ""}${m.now ? " · now" : ""}</div><h2>${m.label}</h2>
      ${m.abbr ? `<div class="frm">${m.formula}</div>` : ""}<p>${m.blurb || ""}</p>${m.url ? `<p><a class="btn" href="${m.url}">Research page ↗</a></p>` : ""}</div>
      <div class="els">${m.elements.map(s => `<div class="el">${s}</div>`).join("")}${(m.dopants || []).map(s => `<div class="el dop">${s}</div>`).join("")}</div>`;
  }
  function update() {
    const svg = document.getElementById("ptable"); const vis = new Set(visible().map(m => m.id));
    svg.querySelectorAll(".bond").forEach(p => p.classList.toggle("hidden", !vis.has(p.dataset.id)));
    svg.querySelectorAll(".bond-hit").forEach(p => p.style.display = vis.has(p.dataset.id) ? "" : "none");
    svg.querySelectorAll(".sym").forEach(t => t.classList.remove("lit"));
    const g = svg._lit; g.innerHTML = "";
    const m = MATS.find(x => x.id === selected);
    if (m) {
      g.append(mk("path", { d: pathFor(m), class: "bond lit" }));
      (m.dopants || []).forEach(dp => { const a = BY[dp], b = BY[m.elements[0]]; g.append(mk("path", { d: `M${cx(a)} ${cy(a)} L${cx(b)} ${cy(b)}`, class: "bond lit dop" })); });
      m.elements.forEach(s => { const e = BY[s]; g.append(mk("circle", { cx: cx(e), cy: cy(e), r: CELL / 2 - 4, class: "node" })); svg.querySelector(`.sym[data-sym="${s}"]`).classList.add("lit"); });
      (m.dopants || []).forEach(s => { const e = BY[s]; g.append(mk("circle", { cx: cx(e), cy: cy(e), r: CELL / 2 - 4, class: "node dop" })); svg.querySelector(`.sym[data-sym="${s}"]`).classList.add("lit"); });
    }
    renderTabs(); renderChips(); renderDetail();
    history.replaceState(null, "", "#" + selected);
  }
  function select(id) { selected = id; const m = MATS.find(x => x.id === id); if (family !== "all" && m && m.family !== family) family = "all"; update(); }

  document.addEventListener("DOMContentLoaded", () => { build(); update(); });
})();
