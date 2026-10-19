/* PPMS page: cryostat status + trends (read-only, written by the lab PC collector)
   and He cylinder inventory (read/write through a Google Apps Script web app).
   Charts: one measure per chart — temperature and pressure never share an axis. */
(function () {
  const C = (window.SITE || {}).ppms || {};
  const L = C.limits || {};
  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v, d) => (v == null || v === "" || isNaN(+v)) ? null : +(+v).toFixed(d);
  const SUP = C.suppliers || [];

  /* ---------- status ---------- */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const stamp = d => `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  /* state is always rendered with its own word, never colour alone (red/green are hard to tell apart for deutan readers) */
  const chip = (state, word) => `<span class="st ${state}">${esc(word)}</span>`;

  function card(label, value, unit, state, word, sub) {
    const c = el("div", "pcard");
    c.innerHTML = `<div class="pc-top"><span class="pc-label">${esc(label)}</span>${state ? chip(state, word) : ""}</div>
      <div class="pc-val">${value == null ? "—" : esc(value)}<small>${esc(unit || "")}</small></div>
      <div class="pc-sub">${sub || ""}</div>`;
    return c;
  }

  /* Telemetry fetch, clock skew and the stale/warn thresholds live in ppms-live.js so
     the home tile and this page can never disagree about them. */
  const Live = window.PPMSLive;
  let TEL = null;
  const seen = m => Live.seen(m);
  const staleAt = ms => Live.staleAt(ms);
  const ago = ms => Live.ago(ms);
  /* A measurement that stopped arriving keeps its last value but loses its state word:
     a green "normal" on an hour-old number is the one failure mode worth designing out. */
  const freshness = ms => ms == null ? "" : staleAt(ms)
    ? `${esc(ago(Date.now() - ms))} · not updating` : `${esc(ago(Date.now() - ms))}`;

  async function renderStatus() {
    const box = $("#ppms-status"), banner = $("#ppms-banner");
    TEL = await Live.load();
    const latest = (TEL && TEL.latest) || {};
    const live = latest.temp_k || latest.psi || latest.heater_w;
    let s = null;
    if (!live) {
      try { const r = await fetch(C.statusUrl, { cache: "no-store" }); if (r.ok) s = await r.json(); } catch (e) { /* offline or not deployed yet */ }
      if (!s) { box.append(el("p", "subtle", "No reading has been uploaded yet. The lab PC collector is not connected.")); return; }
      if (s.demo) banner.hidden = false;
      return renderFromFile(box, s);
    }
    if (latest.src && latest.src !== "LIVE") banner.hidden = false;   /* MOCK or TEST data */

    const tSeen = seen(latest.temp_k), pSeen = seen(latest.psi), hSeen = seen(latest.heater_w);
    const collector = seen({ ts: latest.seen });
    $("#ppms-updated").innerHTML = collector == null ? ""
      : `Collector last reported ${esc(ago(Date.now() - collector))} · ${esc(stamp(new Date(collector)))} ` +
        (staleAt(collector) ? chip("crit", "stale") : chip("ok", "live"));

    const temp = latest.temp_k ? latest.temp_k.v : null, psi = latest.psi ? latest.psi.v : null;
    const sp = L.pressureSetpoint, d = psi == null ? null : psi - sp;
    const pState = Live.pressState(psi, staleAt(pSeen));
    const tState = Live.tempState(temp, staleAt(tSeen));
    const device = (name, status) => !status || status === "OK" ? "" : ` · ${esc(name)} ${esc(status.toLowerCase())}`;

    box.append(
      card("Recondenser cold tip", num(temp, 2), "K", tState, tState === "ok" ? "normal" : tState === "warn" ? "warm" : "too warm",
        freshness(tSeen) + device("SCM10", latest.scm)),
      card("Dewar pressure", num(psi, 3), "psi", pState, pState === "ok" ? "on setpoint" : pState === "warn" ? "off setpoint" : "far off setpoint",
        (d == null ? "" : `setpoint ${sp} psi · ${d >= 0 ? "+" : ""}${d.toFixed(3)} psi · `) + freshness(pSeen) + device("HRC", latest.hrc)),
      /* The HRC reports watts, not a percentage — the units the instrument actually sends. */
      card("HRC heater", num(latest.heater_w ? latest.heater_w.v : null, 2), "W", null, "",
        "0 W while the pressure rises is the September fault signature")
    );
  }

  function renderFromFile(box, s) {
    const up = new Date(s.updated), stale = (Date.now() - up) / 6e4 > (L.staleMin || 15);
    $("#ppms-updated").innerHTML = `Last reading ${esc(ago(Date.now() - up))} · ${esc(stamp(up))} ${stale ? chip("crit", "stale") : chip("ok", "live")}`;

    const rc = s.recondenser || {}, pp = s.ppms || {}, cp = s.compressor || {};
    const sp = L.pressureSetpoint, d = rc.pressure_psi == null ? null : rc.pressure_psi - sp;
    const pState = d == null ? null : Math.abs(d) >= L.pressureCrit ? "crit" : Math.abs(d) >= L.pressureWarn ? "warn" : "ok";
    const tState = rc.temp_k == null ? null : rc.temp_k >= L.tempCrit ? "crit" : rc.temp_k >= L.tempWarn ? "warn" : "ok";

    box.append(
      card("Recondenser cold tip", num(rc.temp_k, 2), "K", tState, tState === "ok" ? "normal" : tState === "warn" ? "warm" : "too warm",
        rc.temp_raw_k != null ? `sensor reads ${num(rc.temp_raw_k, 3)} K · calibration offset applied` : ""),
      card("Dewar pressure", num(rc.pressure_psi, 3), "psi", pState, pState === "ok" ? "on setpoint" : pState === "warn" ? "off setpoint" : "far off setpoint",
        d == null ? "" : `setpoint ${sp} psi · ${d >= 0 ? "+" : ""}${d.toFixed(3)} psi`),
      card("HRC heater", num(rc.heater_pct, 1), "%", null, "", "0 % while the pressure rises is the September fault signature"),
      card("PPMS sample space", num(pp.temp_k, 2), "K", null, "", `${esc(pp.chamber || "chamber unknown")}${pp.field_oe != null ? ` · ${num(pp.field_oe, 0)} Oe` : ""}`),
      card("Compressor", cp.state ? cp.state.toUpperCase() : null, "", cp.state === "on" ? "ok" : cp.state ? "crit" : null, cp.state === "on" ? "running" : "stopped",
        cp.low_psig != null ? `low ${num(cp.low_psig, 0)} psig · high ${num(cp.high_psig, 0)} psig` : "")
    );
  }

  /* ---------- trend charts ---------- */
  let LOG = [];
  async function loadLog() {
    /* Points come from the same telemetry call renderStatus already made: one request,
       not two, and the chart can never disagree with the cards above it. */
    if (TEL && TEL.points && TEL.points.length) {
      LOG = TEL.points.map(p => ({ t: new Date(p[0]), recon_temp_k: p[1], dewar_psi: p[2], heater_w: p[3] }))
                      .filter(o => o.t && !isNaN(o.t));
      return;
    }
    try {
      const r = await fetch(C.logUrl, { cache: "no-store" }); if (!r.ok) return;
      const lines = (await r.text()).trim().split(/\r?\n/); const head = lines.shift().split(",").map(h => h.trim());
      LOG = lines.map(l => { const p = l.split(","); const o = {}; head.forEach((h, i) => o[h] = p[i]); o.t = new Date(o.ts); return o; })
                 .filter(o => o.t && !isNaN(o.t));
    } catch (e) { /* no log yet */ }
  }

  /* single-series line chart with crosshair + tooltip. w/h in user units; scales with the container. */
  function lineChart(host, pts, opt) {
    host.innerHTML = "";
    if (pts.length < 2) { host.append(el("p", "subtle", "Not enough points in this window yet.")); return; }
    const narrow = host.clientWidth && host.clientWidth < 560;
    const W = narrow ? 380 : 880, H = narrow ? 250 : 190;
    const m = narrow ? { t: 12, r: 12, b: 26, l: 54 } : { t: 14, r: 16, b: 26, l: 48 };
    const xs = pts.map(p => +p.t), ys = pts.map(p => p.v);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (opt.include != null) { y0 = Math.min(y0, opt.include); y1 = Math.max(y1, opt.include); }
    const pad = (y1 - y0) * 0.25 || Math.abs(y1 || 1) * 0.02; y0 -= pad; y1 += pad;
    const X = v => m.l + (v - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
    const Y = v => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);

    const ticks = narrow ? 3 : 4, gy = Array.from({ length: ticks + 1 }, (_, i) => y0 + (y1 - y0) * i / ticks);
    const fmtT = d => `${MON[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "chart"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${opt.title} from ${fmtT(new Date(x0))} to ${fmtT(new Date(x1))}`);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${X(+p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    svg.innerHTML =
      gy.map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
                   <text class="ax ${narrow ? "big" : ""}" x="${m.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(opt.dp)}</text>`).join("") +
      /* the setpoint line is named in the figure caption, not on the plot, so it never lands on the data */
      (opt.include != null ? `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${Y(opt.include).toFixed(1)}" y2="${Y(opt.include).toFixed(1)}"/>` : "") +
      `<text class="ax ${narrow ? "big" : ""}" x="${m.l}" y="${H - 8}">${fmtT(new Date(x0))}</text>
       <text class="ax ${narrow ? "big" : ""}" x="${W - m.r}" y="${H - 8}" text-anchor="end">${fmtT(new Date(x1))}</text>
       <path class="line" style="stroke:${opt.color}" d="${path}"/>
       <g class="cross off"><line y1="${m.t}" y2="${H - m.b}"/><circle r="4.5" style="fill:${opt.color}"/></g>`;
    host.append(svg);

    const tip = el("div", "chart-tip"); tip.hidden = true; host.append(tip);
    const cross = svg.querySelector(".cross"), cl = cross.querySelector("line"), cc = cross.querySelector("circle");
    svg.addEventListener("pointermove", ev => {
      const r = svg.getBoundingClientRect(), ux = (ev.clientX - r.left) / r.width * W;
      let best = 0, bd = Infinity;
      pts.forEach((p, i) => { const dd = Math.abs(X(+p.t) - ux); if (dd < bd) { bd = dd; best = i; } });
      const p = pts[best]; cross.classList.remove("off");
      cl.setAttribute("x1", X(+p.t)); cl.setAttribute("x2", X(+p.t)); cc.setAttribute("cx", X(+p.t)); cc.setAttribute("cy", Y(p.v));
      tip.hidden = false; tip.innerHTML = `<b>${p.v.toFixed(opt.dp)} ${esc(opt.unit)}</b><span>${esc(fmtT(p.t))}</span>`;
      tip.style.left = Math.min(Math.max(X(+p.t) / W * r.width, 8), r.width - 8) + "px";
    });
    svg.addEventListener("pointerleave", () => { cross.classList.add("off"); tip.hidden = true; });
  }

  let win = 24;
  function drawTrends() {
    const cut = Date.now() - win * 36e5;
    const rows = LOG.filter(r => +r.t >= cut);
    /* null is a gap the instrument did not fill; +null is 0 and would draw a cold tip at
       absolute zero, so missing points are dropped rather than coerced. */
    const series = key => rows.map(r => ({ t: r.t, v: r[key] == null || r[key] === "" ? NaN : +r[key] }))
                              .filter(p => !isNaN(p.v));
    lineChart($("#chart-temp"), series("recon_temp_k"), { title: "Recondenser cold tip temperature", unit: "K", dp: 2, color: "var(--violet-2)" });
    lineChart($("#chart-psi"), series("dewar_psi"), { title: "Dewar pressure", unit: "psi", dp: 3, color: "var(--orange)", include: L.pressureSetpoint });
    document.querySelectorAll("[data-win]").forEach(b => b.classList.toggle("on", +b.dataset.win === win));
  }

  /* ---------- helium cylinders ---------- */
  const ACTIONS = {
    delivery: { label: "Delivery — new cylinders in", full: +1, empty: 0 },
    open:     { label: "Opened — full → empty",      full: -1, empty: +1 },
    ret:      { label: "Returned — empties collected", full: 0, empty: -1 }
  };
  let EVENTS = [], offline = !C.apiUrl;

  const lsKey = "he-cylinders-demo";
  const loadLocal = () => { try { return JSON.parse(localStorage.getItem(lsKey)) || []; } catch (e) { return []; } };
  const saveLocal = () => localStorage.setItem(lsKey, JSON.stringify(EVENTS));

  async function api(params) {
    const r = await fetch(C.apiUrl, { method: "POST", body: new URLSearchParams(params) }); // form body → no CORS preflight
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "request failed");
    return j;
  }

  function stock(list) {
    const t = {}; SUP.forEach(s => t[s.id] = { full: 0, empty: 0 });
    (list || EVENTS).forEach(e => { const a = ACTIONS[e.action], s = t[e.supplier]; if (!a || !s) return; s.full += a.full * +e.qty; s.empty += a.empty * +e.qty; });
    return t;
  }
  /* a count can never go below zero — catch it here and again in the sheet, which is the real guard */
  function wouldGoNegative(entry) {
    const t = stock(EVENTS.concat([entry]))[entry.supplier];
    if (!t) return "Unknown supplier.";
    if (t.full < 0) return `Only ${stock()[entry.supplier].full} full cylinder(s) on record — that would leave ${t.full}.`;
    if (t.empty < 0) return `Only ${stock()[entry.supplier].empty} empty cylinder(s) on record — that would leave ${t.empty}.`;
    return "";
  }

  function renderStock() {
    const t = stock(), box = $("#he-stock"); box.innerHTML = "";
    SUP.forEach(s => {
      const g = el("div", "he-sup");
      const low = t[s.id].full <= (C.lowStock ?? 2);
      g.innerHTML = `<div class="he-name">${esc(s.name)}<small>${esc(C.cylinder)} cylinders</small></div>
        <div class="he-nums">
          <div class="he-n"><b>${t[s.id].full}</b><span>full ${low ? chip("warn", "low") : ""}</span></div>
          <div class="he-n empty"><b>${t[s.id].empty}</b><span>empty</span></div>
        </div>`;
      box.append(g);
    });
    const log = $("#he-log"); log.innerHTML = "";
    if (!EVENTS.length) { log.append(el("li", "subtle", "No movements recorded yet.")); return; }
    EVENTS.slice().reverse().slice(0, 40).forEach(e => {
      const s = SUP.find(x => x.id === e.supplier), a = ACTIONS[e.action];
      const li = el("li");
      const d = new Date(e.ts);
      li.innerHTML = `<span class="d">${MON[d.getMonth()]} ${d.getDate()}</span>
        <span class="s">${esc(s ? s.name : e.supplier)}</span>
        <span class="a">${esc(a ? a.label.split(" — ")[0] : e.action)} ×${e.qty}${e.note ? ` <small>${esc(e.note)}</small>` : ""}</span>
        <button class="undo" data-id="${esc(e.id)}" title="Remove this line">undo</button>`;
      log.append(li);
    });
  }

  function msg(text, bad) { const m = $("#he-msg"); m.textContent = text; m.className = "he-msg" + (bad ? " bad" : " good"); }

  /* the sheet round trip is ~2 s, so say so rather than showing an empty panel — and if it fails,
     show nothing at all: a 0 that is really "unknown" is worse than no number */
  async function loadInventory() {
    if (offline) { EVENTS = loadLocal(); $("#he-offline").hidden = false; return renderStock(); }
    $("#he-stock").append(el("p", "subtle", "Reading the sheet\u2026"));
    try {
      EVENTS = (await api({ action: "list" })).events || [];
      renderStock();
    } catch (e) {
      $("#he-stock").innerHTML = "";
      msg("Could not reach the sheet, so the counts are not shown: " + e.message, true);
    }
  }

  function wireInventory() {
    const sel = $("#he-sup-sel"); SUP.forEach(s => sel.append(new Option(s.name, s.id)));
    const act = $("#he-act"); Object.entries(ACTIONS).forEach(([k, a]) => act.append(new Option(a.label, k)));
    $("#he-form").addEventListener("submit", async ev => {
      ev.preventDefault();
      const e = { supplier: sel.value, action: act.value, qty: Math.max(1, +$("#he-qty").value || 1), note: $("#he-note").value.trim(), code: $("#he-code").value.trim() };
      if (!offline && !e.code) return msg("Enter the edit code.", true);
      const bad = wouldGoNegative(e); if (bad) return msg(bad, true);
      const btn = $("#he-save"); btn.disabled = true;
      try {
        if (offline) { EVENTS.push({ ...e, id: "L" + Date.now(), ts: new Date().toISOString() }); saveLocal(); }
        else EVENTS = (await api({ ...e, action: "add", kind: act.value })).events;
        $("#he-note").value = ""; $("#he-qty").value = 1; renderStock(); msg("Recorded.", false);
      } catch (err) { msg(err.message, true); } finally { btn.disabled = false; }
    });
    $("#he-log").addEventListener("click", async ev => {
      const b = ev.target.closest(".undo"); if (!b) return;
      if (!confirm("Remove this line?")) return;
      try {
        if (offline) { EVENTS = EVENTS.filter(x => x.id !== b.dataset.id); saveLocal(); }
        else EVENTS = (await api({ action: "undo", id: b.dataset.id, code: $("#he-code").value.trim() })).events;
        renderStock(); msg("Removed.", false);
      } catch (err) { msg(err.message, true); }
    });
  }

  /* ---------- service events ----------
     Two levels: a list of one-line events, and one event with the actions taken on it.
     People are recorded as initials (C.Y.U), separated by commas when several worked on the
     same action — the page is public, so a full name does not belong in it. */
  const EQUIP = C.equipment || [];
  /* evOffline until the web app has been redeployed with the events code: the old script
     answers an unknown action with "Wrong code", and five of those lock the cylinder
     ledger for ten minutes. A page load must never be able to do that. */
  let EV = [], ACT = [], evOffline = !C.apiUrl || !C.events, evFilter = "all", evAll = false, evCur = null;
  /* kept in memory for the visit only — typing the code again for every action is how a
     log stops being written. It is never stored. */
  let evCode = "";
  const EV_PAGE = 12;

  const pad = n => String(n).padStart(2, "0");
  const toInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDay = d => `${MON[d.getMonth()]} ${d.getDate()}`;
  const fmtDT = d => `${MON[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isoDT = d => `${isoDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  /* days and hours, never "0.3 d": a service report is read by someone deciding whether to
     call the vendor, and 7 h means something to them that 0.3 d does not */
  function dur(ms) {
    if (ms == null || ms < 0) return "—";
    const m = Math.round(ms / 6e4), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return `${d} d ${h % 24} h`;
    if (h >= 1) return `${h} h ${m % 60} m`;
    return `${m} m`;
  }
  /* The native datetime field will not flip 오전/오후 on a click — only on an arrow key —
     so each one gets a button beside it that shifts the value by twelve hours. */
  /* always through here: the AM/PM button's label is driven by the input event */
  const setWhen = (inp, d) => { inp.value = toInput(d); inp.dispatchEvent(new Event("input")); };

  function wireAmPm(root) {
    (root || document).querySelectorAll("input[type=datetime-local]").forEach(inp => {
      if (inp.dataset.ampm) return;
      inp.dataset.ampm = "1";
      const b = el("button", "ampm"); b.type = "button";
      b.title = "Switch morning / afternoon";
      const label = () => {
        const d = new Date(inp.value);
        const ok = inp.value && !isNaN(d);
        b.textContent = !ok ? "AM/PM" : d.getHours() < 12 ? "AM" : "PM";
        b.disabled = !ok;
      };
      b.onclick = () => {
        const d = new Date(inp.value); if (!inp.value || isNaN(d)) return;
        inp.dataset.touched = "1";
        d.setHours(d.getHours() + (d.getHours() < 12 ? 12 : -12));
        inp.value = toInput(d); label();
      };
      inp.addEventListener("input", label);
      inp.insertAdjacentElement("afterend", b);
      label();
    });
  }

  const evActs = id => ACT.filter(a => a.event === id).sort((x, y) => new Date(x.ts) - new Date(y.ts));
  const evSorted = () => EV.slice().sort((a, b) => new Date(b.opened) - new Date(a.opened));
  const elapsed = e => (e.closed ? new Date(e.closed) : new Date()) - new Date(e.opened);
  const evMsg = (t, bad) => { const m = $("#ev-msg"); if (m) { m.textContent = t; m.className = "he-msg" + (bad ? " bad" : " good"); } };

  const evLocal = () => { try { const j = JSON.parse(localStorage.getItem("ppms-events-demo")) || {}; return [j.events || [], j.actions || []]; } catch (e) { return [[], []]; } };
  const evSaveLocal = () => localStorage.setItem("ppms-events-demo", JSON.stringify({ events: EV, actions: ACT }));
  const uid = () => "L" + Math.random().toString(36).slice(2, 9);

  async function evApi(params) {
    if (evOffline) return null;
    const j = await api(params);
    EV = j.events || []; ACT = j.actions || [];
    return j;
  }

  async function loadEvents() {
    if (evOffline) {
      [EV, ACT] = evLocal();
      const n = $("#ev-offline"); n.hidden = false;
      if (C.apiUrl) n.innerHTML = "<b>Not writing to the sheet yet.</b> The web app has not been redeployed with the event log, so anything added here stays in this browser.";
      return renderEvents();
    }
    try {
      await evApi({ action: "events" });
    } catch (err) {
      /* The sheet is reachable but has not been given the new script yet. Say that plainly
         rather than showing an empty log that looks like "no events ever happened". */
      evOffline = true; [EV, ACT] = evLocal();
      const n = $("#ev-offline");
      n.hidden = false;
      if (/unknown action/i.test(err.message)) n.innerHTML = "<b>The sheet has not been updated for events yet.</b> Until the Apps Script is redeployed, anything you add here stays in this browser only.";
    }
    renderEvents();
  }

  /* ---- list ---- */
  function renderSummary() {
    const box = $("#ev-summary"); box.innerHTML = "";
    const open = EV.filter(e => e.status !== "resolved");
    const cut = Date.now() - 90 * 864e5;
    const recent = EV.filter(e => +new Date(e.opened) >= cut);
    const spent = recent.reduce((t, e) => t + elapsed(e), 0);
    const longest = recent.length ? Math.max(...recent.map(elapsed)) : null;
    const oldest = open.length ? Math.max(...open.map(e => Date.now() - new Date(e.opened))) : null;
    const last = EV.length ? Math.min(...EV.map(e => Date.now() - new Date(e.opened))) : null;
    box.append(
      card("Open now", open.length, open.length === 1 ? "event" : "events",
        open.length ? "warn" : "ok", open.length ? "needs work" : "all clear",
        oldest == null ? "nothing open" : `oldest open ${esc(dur(oldest))}`),
      card("Events · 90 days", recent.length, "", null, "",
        `${recent.filter(e => e.status === "resolved").length} resolved · ${recent.filter(e => e.status !== "resolved").length} open`),
      card("Service time · 90 days", recent.length ? dur(spent) : null, "", null, "",
        longest == null ? "" : `longest single event ${esc(dur(longest))}`),
      card("Last event", last == null ? null : dur(last), last == null ? "" : "ago", null, "",
        EV.length ? esc(evSorted()[0].title.slice(0, 48)) : "nothing logged yet")
    );
  }

  function renderEvents() {
    if (evCur) return renderDetail(evCur);
    $("#ev-list-view").hidden = false; $("#ev-detail-view").hidden = true;
    renderSummary();
    const list = $("#ev-list"); list.innerHTML = "";
    let rows = evSorted();
    if (evFilter === "open") rows = rows.filter(e => e.status !== "resolved");
    if (evFilter === "resolved") rows = rows.filter(e => e.status === "resolved");
    const more = $("#ev-more");
    more.hidden = rows.length <= EV_PAGE;
    more.textContent = evAll ? "Show fewer" : `Show all ${rows.length}`;
    if (!evAll) rows = rows.slice(0, EV_PAGE);
    if (!rows.length) { list.append(el("li", "subtle", EV.length ? "Nothing in this filter." : "No events logged yet.")); return; }
    rows.forEach(e => {
      const open = e.status !== "resolved", n = evActs(e.id).length;
      const li = el("li", open ? "is-open" : "");
      li.dataset.id = e.id; li.tabIndex = 0; li.setAttribute("role", "button");
      li.innerHTML = `<span class="d">${esc(fmtDay(new Date(e.opened)))}</span>
        <span>${chip(open ? "warn" : "ok", open ? "open" : "resolved")}</span>
        <span class="t">${esc(e.title)}<small>${esc(e.equipment)}${e.issue ? " · " + esc(e.issue.split("\n")[0].slice(0, 88)) : ""}</small></span>
        <span class="w">${esc(e.reporter)}</span>
        <span class="n">${n} action${n === 1 ? "" : "s"}</span><span class="chev">›</span>`;
      list.append(li);
    });
  }

  /* ---- one event ---- */
  function renderDetail(id) {
    const e = EV.find(x => x.id === id);
    if (!e) { evCur = null; location.hash = ""; return renderEvents(); }
    $("#ev-list-view").hidden = true;
    const box = $("#ev-detail-view"); box.hidden = false;
    const open = e.status !== "resolved", acts = evActs(e.id);
    let r = {}; try { r = JSON.parse(e.readings || "{}"); } catch (err) { r = {}; }

    box.innerHTML = `
      <a class="ev-back" id="ev-back">‹ All events</a>
      <div class="ev-title">${esc(e.title)} ${chip(open ? "warn" : "ok", open ? "open" : "resolved")}</div>
      <div class="ev-meta"><b>${esc(e.no || "—")}</b> · ${esc(e.equipment)} · opened <b>${esc(fmtDT(new Date(e.opened)))}</b>
        by <b>${esc(e.reporter)}</b> · ${open ? "running" : "took"} <b>${esc(dur(elapsed(e)))}</b>${e.closed ? ` · closed ${esc(fmtDT(new Date(e.closed)))}` : ""}</div>
      <div class="ev-ops">
        ${open ? `<button class="btn small primary" id="ev-resolve">Mark resolved</button>` : `<button class="btn small" id="ev-reopen">Reopen</button>`}
        <button class="btn small" id="ev-pdf">Download PDF</button>
        <button class="btn small" id="ev-edit">Edit</button>
        <button class="btn small" id="ev-delete">Delete</button>
      </div>
      <form class="ev-form" id="ev-resolve-form" hidden>
        <textarea id="ev-r-outcome" rows="3" placeholder="outcome — what it turned out to be, and what state the kit is in now"></textarea>
        <div class="ev-row"><input id="ev-r-closed" type="datetime-local" aria-label="When it ended">
          <input id="ev-r-code" type="password" placeholder="edit code" autocomplete="current-password">
          <button class="btn primary" type="submit">Close event</button></div>
      </form>
      <form class="ev-form" id="ev-edit-form" hidden>
        <div class="ev-row"><select id="ev-e-equip"></select><input id="ev-e-equip-other" placeholder="equipment" hidden>
          <input id="ev-e-opened" type="datetime-local"><input id="ev-e-who" placeholder="initials"></div>
        <input id="ev-e-title" placeholder="title">
        <textarea id="ev-e-issue" rows="3" placeholder="the issue"></textarea>
        <textarea id="ev-e-outcome" rows="2" placeholder="outcome"></textarea>
        <div class="ev-row"><input id="ev-e-code" type="password" placeholder="edit code" autocomplete="current-password">
          <button class="btn primary" type="submit">Save</button></div>
      </form>
      <div class="he-msg" id="ev-dmsg"></div>
      <div class="ev-box"><h3>Issue</h3><p>${e.issue ? esc(e.issue) : "<span class=\"subtle\">Nothing written yet — use Edit to add it.</span>"}</p>
        ${r.at ? `<div class="ev-read">
          ${r.psi != null ? `<div><b>${esc((+r.psi).toFixed(3))} psi</b>dewar · setpoint ${esc(L.pressureSetpoint)}</div>` : ""}
          ${r.heater_w != null ? `<div><b>${esc((+r.heater_w).toFixed(2))} W</b>HRC heater</div>` : ""}
          ${r.temp_k != null ? `<div><b>${esc((+r.temp_k).toFixed(2))} K</b>cold tip</div>` : ""}
          <div><b>${esc(fmtDT(new Date(r.at)))}</b>reading attached</div></div>` : ""}</div>
      ${e.outcome ? `<div class="ev-box"><h3>Outcome</h3><p>${esc(e.outcome)}</p></div>` : ""}
      <h2 class="sec">Actions · ${acts.length}</h2>
      <ul class="tl" id="ev-tl"></ul>
      <form class="ev-form" id="ev-act-form">
        <div class="ev-row"><input id="ev-a-ts" type="datetime-local" aria-label="When">
          <input id="ev-a-who" placeholder="initials — C.Y.U, J.D.W" aria-label="Who did it" autocomplete="off"></div>
        <input id="ev-a-what" placeholder="what was done" aria-label="Action">
        <input id="ev-a-result" placeholder="result (optional)" aria-label="Result">
        <div class="ev-row"><input id="ev-a-code" type="password" placeholder="edit code" autocomplete="current-password">
          <button class="btn primary" type="submit">Add action</button></div>
      </form>
      <div class="subtle ev-hint">Every action keeps its own time and initials. The PDF is built from exactly these lines.</div>`;

    const tl = $("#ev-tl");
    if (!acts.length) tl.append(el("li", "subtle", "No action recorded yet."));
    acts.forEach((a, i) => {
      const li = el("li", i === acts.length - 1 ? "last" : "");
      li.innerHTML = `<button class="del" data-act="${esc(a.id)}">delete</button>
        <span class="when">${esc(fmtDT(new Date(a.ts)))}</span><span class="who">${esc(a.who)}</span>
        <div class="what">${esc(a.what)}</div>${a.result ? `<div class="res">→ ${esc(a.result)}</div>` : ""}`;
      tl.append(li);
    });
    wireDetail(e);
  }

  function fillEquip(sel, other, value) {
    sel.innerHTML = "";
    EQUIP.forEach(q => sel.append(new Option(q.label, q.id)));
    const known = EQUIP.find(q => q.label === value);
    if (value && !known) { sel.value = "other"; other.hidden = false; other.value = value; }
    else if (known) sel.value = known.id;
    sel.onchange = () => { other.hidden = sel.value !== "other"; if (!other.hidden) other.focus(); };
    other.hidden = sel.value !== "other";
  }
  const equipValue = (sel, other) => sel.value === "other" ? other.value.trim() : (EQUIP.find(q => q.id === sel.value) || {}).label || "";

  function wireDetail(e) {
    const dmsg = (t, bad) => { const m = $("#ev-dmsg"); m.textContent = t; m.className = "he-msg" + (bad ? " bad" : " good"); };
    $("#ev-back").onclick = () => { location.hash = ""; };
    wireAmPm($("#ev-detail-view"));
    /* Writing up an old event should not mean re-typing its date on every line: when the
       event is more than a day behind, the next action starts where the last one ended. */
    const acts = evActs(e.id), last = acts[acts.length - 1];
    const tail = new Date(Math.max(+new Date(e.opened), last ? +new Date(last.ts) : 0));
    setWhen($("#ev-a-ts"), Date.now() - tail > 864e5 ? tail : new Date());
    $("#ev-a-who").value = (last && last.who) || e.reporter || "";
    document.querySelectorAll("#ev-detail-view input[type=password]").forEach(i => i.value = evCode);
    $("#ev-pdf").onclick = () => printReport(e);

    const run = async (params, local, ok) => {
      try {
        if (evOffline) { local(); evSaveLocal(); } else { await evApi(params); evCode = params.code || evCode; }
        renderEvents(); if (ok) dmsg(ok, false);
      } catch (err) { dmsg(err.message, true); }
    };

    $("#ev-act-form").onsubmit = async ev => {
      ev.preventDefault();
      const ts = $("#ev-a-ts").value, who = $("#ev-a-who").value.trim(), what = $("#ev-a-what").value.trim();
      const result = $("#ev-a-result").value.trim(), code = $("#ev-a-code").value.trim();
      if (!what) return dmsg("Write what was done.", true);
      if (!who) return dmsg("Enter initials — C.Y.U", true);
      if (!evOffline && !code) return dmsg("Enter the edit code.", true);
      await run({ action: "act_add", event: e.id, ts: new Date(ts).toISOString(), who, what, result, code },
        () => ACT.push({ id: uid(), event: e.id, ts: new Date(ts).toISOString(), who, what, result }));
    };

    $("#ev-tl").onclick = async ev => {
      const b = ev.target.closest(".del"); if (!b) return;
      if (!confirm("Remove this action?")) return;
      const code = $("#ev-a-code").value.trim();
      await run({ action: "act_del", id: b.dataset.act, code }, () => { ACT = ACT.filter(a => a.id !== b.dataset.act); });
    };

    if ($("#ev-resolve")) {
      $("#ev-resolve").onclick = () => {
        const f = $("#ev-resolve-form"); f.hidden = !f.hidden;
        setWhen($("#ev-r-closed"), new Date());
      };
      $("#ev-resolve-form").onsubmit = async ev => {
        ev.preventDefault();
        const closed = new Date($("#ev-r-closed").value).toISOString(), outcome = $("#ev-r-outcome").value.trim();
        const code = $("#ev-r-code").value.trim();
        if (!evOffline && !code) return dmsg("Enter the edit code.", true);
        await run({ action: "ev_close", id: e.id, closed, outcome, code },
          () => { e.closed = closed; e.status = "resolved"; e.outcome = outcome; }, "Closed.");
      };
    }
    if ($("#ev-reopen")) $("#ev-reopen").onclick = async () => {
      if (!confirm("Reopen this event?")) return;
      await run({ action: "ev_reopen", id: e.id, code: prompt("Edit code") || "" },
        () => { e.closed = ""; e.status = "open"; });
    };

    $("#ev-edit").onclick = () => {
      const f = $("#ev-edit-form"); f.hidden = !f.hidden;
      if (f.hidden) return;
      fillEquip($("#ev-e-equip"), $("#ev-e-equip-other"), e.equipment);
      setWhen($("#ev-e-opened"), new Date(e.opened));
      $("#ev-e-who").value = e.reporter; $("#ev-e-title").value = e.title;
      $("#ev-e-issue").value = e.issue; $("#ev-e-outcome").value = e.outcome || "";
    };
    $("#ev-edit-form").onsubmit = async ev => {
      ev.preventDefault();
      const p = { action: "ev_edit", id: e.id, equipment: equipValue($("#ev-e-equip"), $("#ev-e-equip-other")),
        opened: new Date($("#ev-e-opened").value).toISOString(), reporter: $("#ev-e-who").value.trim(),
        title: $("#ev-e-title").value.trim(), issue: $("#ev-e-issue").value.trim(),
        outcome: $("#ev-e-outcome").value.trim(), code: $("#ev-e-code").value.trim() };
      if (!p.title) return dmsg("Give the event a title.", true);
      if (!evOffline && !p.code) return dmsg("Enter the edit code.", true);
      await run(p, () => Object.assign(e, p), "Saved.");
    };

    $("#ev-delete").onclick = async () => {
      if (!confirm("Delete this event and all of its actions? This cannot be undone.")) return;
      const code = evOffline ? "" : (prompt("Edit code") || "");
      try {
        if (evOffline) { EV = EV.filter(x => x.id !== e.id); ACT = ACT.filter(a => a.event !== e.id); evSaveLocal(); }
        else await evApi({ action: "ev_del", id: e.id, code });
        evCur = null; location.hash = ""; renderEvents(); evMsg("Deleted.", false);
      } catch (err) { dmsg(err.message, true); }
    };
  }

  /* ---- the printed report ----
     Built from the stored record each time, so it can never disagree with what is on screen. */
  function printReport(e) {
    const acts = evActs(e.id), open = e.status !== "resolved";
    const people = [...new Set([e.reporter, ...acts.map(a => a.who)]
      .flatMap(w => String(w || "").split(",").map(x => x.trim())).filter(Boolean))];
    let r = {}; try { r = JSON.parse(e.readings || "{}"); } catch (err) { r = {}; }
    const row = (k, v) => `<div class="k">${esc(k)}</div><div>${v}</div>`;
    const now = new Date();
    $("#ev-print").innerHTML = `
      <div class="rp-hd"><h1>Equipment Service Report</h1>
        <div class="rp-org"><b>PPMS &amp; Helium Recondenser</b><br>${esc(C.reportOrg || "")}</div></div>
      <div class="rp-meta">
        ${row("Report No.", esc(e.no || "—"))}${row("Status", open ? "Open" : "Resolved")}
        ${row("Equipment", esc(e.equipment))}${row("Reported by", esc(e.reporter))}
        ${row("Opened", esc(isoDT(new Date(e.opened))))}${row("Closed", e.closed ? esc(isoDT(new Date(e.closed))) : "—")}
        ${row("Elapsed", esc(dur(elapsed(e))) + (open ? " (still open)" : ""))}${row("People", esc(people.join(", "))) }
      </div>
      <h2>1. Issue</h2>
      <p class="rp-body">${esc(e.issue || "—")}</p>
      ${r.at ? `<div class="rp-read">
        ${r.psi != null ? `<div><b>${esc((+r.psi).toFixed(3))} psi</b>dewar pressure · setpoint ${esc(L.pressureSetpoint)}</div>` : ""}
        ${r.heater_w != null ? `<div><b>${esc((+r.heater_w).toFixed(2))} W</b>HRC heater</div>` : ""}
        ${r.temp_k != null ? `<div><b>${esc((+r.temp_k).toFixed(2))} K</b>cold tip</div>` : ""}
        <div><b>${esc(isoDT(new Date(r.at)))}</b>reading attached</div></div>` : ""}
      <h2>2. Actions taken</h2>
      ${acts.length ? `<table><tr><th class="n">#</th><th class="t">Date &amp; time</th><th class="p">Person</th><th>Action</th><th>Result</th></tr>
        ${acts.map((a, i) => `<tr><td class="n">${i + 1}</td><td class="t">${esc(isoDT(new Date(a.ts)).slice(5))}</td>
          <td class="p">${esc(a.who)}</td><td>${esc(a.what)}</td><td>${esc(a.result || "")}</td></tr>`).join("")}
        </table>` : `<p class="rp-body">No action has been recorded for this event.</p>`}
      <h2>3. Outcome</h2>
      <p class="rp-body">${esc(e.outcome || (open ? "Still open at the time this report was printed." : "—"))}</p>
      <div class="rp-sign"><div>Recorded by — ${esc(e.reporter)}</div><div>Checked by</div><div>Date</div></div>
      <div class="rp-ft"><span>Generated ${esc(isoDT(now))} from ${esc(location.host + location.pathname)}</span>
        <span>${esc(e.no || "")}</span></div>`;
    /* browsers name the saved PDF after the document title, so the file arrives as the report number */
    const title = document.title;
    document.title = (e.no || "service-report") + " " + e.title.slice(0, 60);
    const restore = () => { document.title = title; removeEventListener("afterprint", restore); };
    addEventListener("afterprint", restore);
    setTimeout(restore, 60000);
    print();
  }

  function evCsv() {
    const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const head = ["report_no", "status", "equipment", "title", "opened", "closed", "elapsed", "reported_by",
                  "action_no", "action_time", "action_by", "action", "result", "outcome"];
    const lines = [head.join(",")];
    evSorted().forEach(e => {
      const base = [e.no, e.status, e.equipment, e.title, isoDT(new Date(e.opened)),
                    e.closed ? isoDT(new Date(e.closed)) : "", dur(elapsed(e)), e.reporter];
      const acts = evActs(e.id);
      if (!acts.length) lines.push(base.concat(["", "", "", "", "", e.outcome]).map(q).join(","));
      acts.forEach((a, i) => lines.push(base.concat([i + 1, isoDT(new Date(a.ts)), a.who, a.what, a.result, i === acts.length - 1 ? e.outcome : ""]).map(q).join(",")));
    });
    /* BOM first, or Excel on Windows reads the Korean text as mojibake */
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = el("a"); a.href = url; a.download = `ppms-events-${isoDay(new Date())}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function evRoute() {
    const m = /^#event\/(.+)$/.exec(location.hash);
    evCur = m ? m[1] : null;
    renderEvents();
    if (evCur) $("#ev-section").scrollIntoView({ block: "start" });
  }

  /* One writing pass: the event and the actions that make it up go in together, because
     "it ran from here to here and we did these three things" is one thought, not five forms. */
  function actRow(prefill) {
    const row = el("div", "ev-arow");
    row.innerHTML = `<input type="datetime-local" class="a-when" aria-label="When">
      <input class="a-who" placeholder="C.Y.U" aria-label="Initials" autocomplete="off">
      <input class="a-what" placeholder="what was done" aria-label="Action">
      <input class="a-result" placeholder="result (optional)" aria-label="Result">
      <button type="button" class="a-del" title="Remove this line">×</button>`;
    row.querySelector(".a-who").value = prefill.who || "";
    if (prefill.when) row.querySelector(".a-when").value = toInput(prefill.when);
    row.querySelector(".a-del").onclick = () => { row.remove(); if (!$("#ev-f-acts").children.length) addActRow(); };
    /* a time the person actually set is never moved again by the From field */
    row.querySelector(".a-when").addEventListener("change", e => e.target.dataset.touched = "1");
    $("#ev-f-acts").append(row);
    wireAmPm(row);
    return row;
  }
  /* each new line starts where the last one left off — a service call is a sequence, and
     re-typing today's date on every line is what stops people writing the log */
  function addActRow() {
    const rows = [...$("#ev-f-acts").querySelectorAll(".ev-arow")];
    const last = rows[rows.length - 1];
    const lastWhen = last && last.querySelector(".a-when").value;
    const start = $("#ev-f-opened").value;
    const base = lastWhen || start;
    const row = actRow({ who: (last && last.querySelector(".a-who").value) || $("#ev-f-who").value,
                         when: base ? new Date(base) : new Date() });
    row.querySelector(".a-what").focus();
    return row;
  }
  const readActRows = () => [...$("#ev-f-acts").querySelectorAll(".ev-arow")]
    .map(r => ({ ts: r.querySelector(".a-when").value, who: r.querySelector(".a-who").value.trim(),
                 what: r.querySelector(".a-what").value.trim(), result: r.querySelector(".a-result").value.trim() }))
    .filter(a => a.what)
    .sort((x, y) => new Date(x.ts) - new Date(y.ts));

  function wireEvents() {
    fillEquip($("#ev-f-equip"), $("#ev-f-equip-other"), "");
    $("#ev-f-addact").onclick = () => addActRow();
    /* Change "From" and the untouched action lines follow it. Writing up last Tuesday should
       not mean correcting today's date on every line. */
    $("#ev-f-opened").addEventListener("change", () => {
      const d = new Date($("#ev-f-opened").value); if (isNaN(d)) return;
      $("#ev-f-acts").querySelectorAll(".a-when").forEach(i => { if (!i.dataset.touched) setWhen(i, d); });
    });
    const openRow = li => { if (li) location.hash = "event/" + li.dataset.id; };
    $("#ev-list").addEventListener("click", ev => openRow(ev.target.closest("li[data-id]")));
    $("#ev-list").addEventListener("keydown", ev => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const li = ev.target.closest("li[data-id]"); if (!li) return;
      ev.preventDefault(); openRow(li);
    });
    document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => {
      evFilter = b.dataset.filter; evAll = false;
      document.querySelectorAll("[data-filter]").forEach(x => x.classList.toggle("on", x === b));
      renderEvents();
    });
    $("#ev-more").onclick = () => { evAll = !evAll; renderEvents(); };
    $("#ev-csv").onclick = evCsv;
    $("#ev-new").onclick = () => {
      const f = $("#ev-new-form"); f.hidden = !f.hidden;
      if (!f.hidden) {
        wireAmPm(f);
        setWhen($("#ev-f-opened"), new Date());
        $("#ev-f-closed").value = ""; $("#ev-f-closed").dispatchEvent(new Event("input"));
        $("#ev-f-acts").innerHTML = ""; addActRow();
        $("#ev-f-title").focus();
      }
    };
    $("#ev-cancel").onclick = () => { $("#ev-new-form").hidden = true; };
    $("#ev-new-form").onsubmit = async ev => {
      ev.preventDefault();
      const equipment = equipValue($("#ev-f-equip"), $("#ev-f-equip-other"));
      const title = $("#ev-f-title").value.trim(), reporter = $("#ev-f-who").value.trim();
      const issue = $("#ev-f-issue").value.trim(), code = $("#ev-f-code").value.trim();
      const outcome = $("#ev-f-outcome").value.trim();
      const opened = new Date($("#ev-f-opened").value || Date.now());
      const closedRaw = $("#ev-f-closed").value;
      const closed = closedRaw ? new Date(closedRaw) : null;
      const acts = readActRows();
      if (!equipment) return evMsg("Pick the equipment.", true);
      if (!title) return evMsg("Give the event a title.", true);
      if (!reporter) return evMsg("Enter initials — C.Y.U", true);
      if (closed && closed < opened) return evMsg("The end time is before the start time.", true);
      const early = acts.find(a => !a.ts || isNaN(new Date(a.ts)));
      if (early) return evMsg("One of the action lines has no time.", true);
      if (!evOffline && !code) return evMsg("Enter the edit code.", true);
      /* the live readings are copied in at creation, because by the time the event is written
         up the instrument has usually moved on and the number that mattered is gone */
      let readings = "";
      if ($("#ev-f-readings").checked && TEL && TEL.latest) {
        const l = TEL.latest, r = { at: l.seen || new Date().toISOString() };
        if (l.psi) r.psi = l.psi.v;
        if (l.temp_k) r.temp_k = l.temp_k.v;
        if (l.heater_w) r.heater_w = l.heater_w.v;
        if (r.psi != null || r.temp_k != null) readings = JSON.stringify(r);
      }
      const btn = $("#ev-f-save"); btn.disabled = true;
      const steps = 1 + acts.length + (closed ? 1 : 0);
      let done = 0, id = null;
      const step = () => evMsg(`Saving… ${++done} of ${steps}`, false);
      try {
        if (evOffline) {
          id = uid();
          EV.push({ id, no: `PPMS-${opened.getFullYear()}-LOCAL`, created: new Date().toISOString(),
                    opened: opened.toISOString(), closed: closed ? closed.toISOString() : "",
                    status: closed ? "resolved" : "open", equipment, title, issue, reporter, readings, outcome });
          acts.forEach(a => ACT.push({ id: uid(), event: id, ts: new Date(a.ts).toISOString(),
                                       who: a.who || reporter, what: a.what, result: a.result }));
          evSaveLocal(); done = steps;
        } else {
          await evApi({ action: "ev_add", opened: opened.toISOString(), equipment, title, issue,
                        reporter, readings, code });
          evCode = code; step();
          /* the id the server just minted: newest created row */
          id = EV.slice().sort((a, b) => new Date(b.created) - new Date(a.created))[0].id;
          for (const a of acts) {
            await evApi({ action: "act_add", event: id, ts: new Date(a.ts).toISOString(),
                          who: a.who || reporter, what: a.what, result: a.result, code });
            step();
          }
          if (closed) { await evApi({ action: "ev_close", id, closed: closed.toISOString(), outcome, code }); step(); }
          else if (outcome) await evApi({ action: "ev_edit", id, outcome, code });
        }
        $("#ev-new-form").hidden = true;
        ["ev-f-title", "ev-f-issue", "ev-f-outcome", "ev-f-equip-other"].forEach(k => $("#" + k).value = "");
        $("#ev-f-acts").innerHTML = "";
        renderEvents();
        evMsg(acts.length ? `Saved — ${acts.length} action${acts.length === 1 ? "" : "s"}.` : "Saved.", false);
        if (id) location.hash = "event/" + id;
      } catch (err) {
        /* a half-written event is still better than a lost one: say what landed and open it */
        evMsg(id ? `${err.message} — the event was created, ${done - 1} of ${acts.length} actions saved. Open it and add the rest.` : err.message, true);
        if (id) location.hash = "event/" + id;
      } finally { btn.disabled = false; }
    };
    addEventListener("hashchange", evRoute);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    wireInventory(); loadInventory();
    wireEvents(); loadEvents().then(evRoute);
    await renderStatus();          /* fills TEL, which loadLog reads */
    await loadLog(); drawTrends();
    document.querySelectorAll("[data-win]").forEach(b => b.onclick = () => { win = +b.dataset.win; drawTrends(); });
    addEventListener("resize", () => { clearTimeout(window._pr); window._pr = setTimeout(drawTrends, 150); });
  });
})();
