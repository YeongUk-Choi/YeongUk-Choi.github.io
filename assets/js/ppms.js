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
  const ago = ms => { const m = Math.round(ms / 6e4); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; const h = Math.floor(m / 60); return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ago`; };
  /* state is always rendered with its own word, never colour alone (red/green are hard to tell apart for deutan readers) */
  const chip = (state, word) => `<span class="st ${state}">${esc(word)}</span>`;

  function card(label, value, unit, state, word, sub) {
    const c = el("div", "pcard");
    c.innerHTML = `<div class="pc-top"><span class="pc-label">${esc(label)}</span>${state ? chip(state, word) : ""}</div>
      <div class="pc-val">${value == null ? "—" : esc(value)}<small>${esc(unit || "")}</small></div>
      <div class="pc-sub">${sub || ""}</div>`;
    return c;
  }

  /* The collector posts to the Apps Script web app; the page reads what arrived there.
     Every reading carries the server's receipt time as well as the lab PC's clock, and
     age is measured against the server's — a PC whose clock drifted must still look stale. */
  let TEL = null, SKEW = 0;
  async function loadTelemetry() {
    /* Gated by config: an Apps Script that has not been redeployed yet counts an unknown
       action as a wrong edit code, and five page views would lock the inventory for ten
       minutes. The flag is flipped after the new version is deployed, not before. */
    if (!C.apiUrl || !C.telemetry) return null;
    try {
      const r = await fetch(C.apiUrl + "?action=telemetry", { cache: "no-store" });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || !d.ok) return null;
      /* The visitor's clock is not trustworthy either. One offset, measured once. */
      if (d.server_ts) SKEW = Date.now() - new Date(d.server_ts).getTime();
      return d;
    } catch (e) { return null; }   /* not deployed yet, or no network */
  }

  const seen = m => (m && m.ts) ? new Date(m.ts).getTime() + SKEW : null;
  const staleAt = ms => ms == null || (Date.now() - ms) / 6e4 > (L.staleMin || 15);
  /* A measurement that stopped arriving keeps its last value but loses its state word:
     a green "normal" on an hour-old number is the one failure mode worth designing out. */
  const freshness = ms => ms == null ? "" : staleAt(ms)
    ? `${esc(ago(Date.now() - ms))} · not updating` : `${esc(ago(Date.now() - ms))}`;

  async function renderStatus() {
    const box = $("#ppms-status"), banner = $("#ppms-banner");
    TEL = await loadTelemetry();
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
    /* State words are withheld once a value stops updating, so the chip never vouches
       for a number the instrument is no longer producing. */
    const pState = (d == null || staleAt(pSeen)) ? null : Math.abs(d) >= L.pressureCrit ? "crit" : Math.abs(d) >= L.pressureWarn ? "warn" : "ok";
    const tState = (temp == null || staleAt(tSeen)) ? null : temp >= L.tempCrit ? "crit" : temp >= L.tempWarn ? "warn" : "ok";
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

  document.addEventListener("DOMContentLoaded", async () => {
    wireInventory(); loadInventory();
    await renderStatus();          /* fills TEL, which loadLog reads */
    await loadLog(); drawTrends();
    document.querySelectorAll("[data-win]").forEach(b => b.onclick = () => { win = +b.dataset.win; drawTrends(); });
    addEventListener("resize", () => { clearTimeout(window._pr); window._pr = setTimeout(drawTrends, 150); });
  });
})();
