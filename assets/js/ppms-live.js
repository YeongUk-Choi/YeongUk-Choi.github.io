/* Cryostat telemetry shared by the PPMS page and the home tile.
   One fetch, one set of thresholds, one freshness rule — the home tile and the
   detail page must never disagree about whether a number is stale or normal. */
(function () {
  const C = (window.SITE || {}).ppms || {};
  const L = C.limits || {};
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* The collector posts to the Apps Script web app; the page reads what arrived there.
     Age is measured against the server's receipt time, not the lab PC clock — a PC
     whose clock drifted must still look stale. The visitor's clock is not trusted
     either, so one offset is measured per response. */
  let SKEW = 0; const inflight = {};
  async function fetchTel(hours) {
    try {
      const r = await fetch(C.apiUrl + "?action=telemetry" + (hours ? "&hours=" + hours : ""), { cache: "no-store" });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || !d.ok) return null;
      if (d.server_ts) SKEW = Date.now() - new Date(d.server_ts).getTime();
      return d;
    } catch (e) { return null; }   /* not deployed yet, or no network */
  }
  /* Gated by config: an Apps Script that has not been redeployed yet counts an unknown
     action as a wrong edit code, and five page views would lock the inventory for ten
     minutes. The flag is flipped after the new version is deployed, not before. */
  /* `hours` asks the web app for a window instead of its default last-1440-rows; the chart
     needs it for 7 and 30 days. Requests are deduplicated per window, not cached — the
     caller decides what is worth keeping. */
  function load(hours) {
    if (!C.apiUrl || !C.telemetry) return Promise.resolve(null);
    const k = hours || 0;
    if (inflight[k]) return inflight[k];                 /* two callers, one request */
    inflight[k] = fetchTel(hours).finally(() => { delete inflight[k]; });
    return inflight[k];
  }

  const seen = m => (m && m.ts) ? new Date(m.ts).getTime() + SKEW : null;
  const staleAt = ms => ms == null || (Date.now() - ms) / 6e4 > (L.staleMin || 15);
  const ago = ms => { const m = Math.round(ms / 6e4); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; const h = Math.floor(m / 60); return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ago`; };
  /* State words are withheld once a value stops updating, so a chip never vouches for
     a number the instrument is no longer producing. */
  const tempState = (v, stale) => (v == null || stale) ? null : v >= L.tempCrit ? "crit" : v >= L.tempWarn ? "warn" : "ok";
  const pressState = (v, stale) => {
    if (v == null || stale) return null;
    const d = Math.abs(v - L.pressureSetpoint);
    return d >= L.pressureCrit ? "crit" : d >= L.pressureWarn ? "warn" : "ok";
  };

  /* ---------- home tile ---------- */
  const RANK = { ok: 0, warn: 1, crit: 2 };
  let shown = false;                 /* has this tile ever displayed a real reading? */
  const num = (v, d) => (v == null || v === "" || isNaN(+v)) ? null : (+v).toFixed(d);

  async function renderTile() {
    const box = document.getElementById("ppms-tile");
    if (!box) return;
    const put = (sel, html) => { const n = box.querySelector(sel); if (n) n.innerHTML = html; };
    const state = (s, word) => put(".pt-state", s ? `<span class="st ${s}">${esc(word)}</span>` : "");

    const tel = await load();
    const latest = (tel && tel.latest) || {};
    if (!(latest.temp_k || latest.psi || latest.heater_w)) {
      /* A failed refresh must not leave yesterday's numbers looking current: they are
         dimmed and the line underneath says where they came from. */
      state(null, "");
      box.querySelectorAll(".ps").forEach(n => n.classList.add("dim"));
      put(".pt-sub", shown ? "Could not reach the cryostat just now — the readings above are the last ones received."
                           : "No live reading right now — open for the log and the helium stock.");
      return;
    }
    shown = true;

    const tSeen = seen(latest.temp_k), pSeen = seen(latest.psi), hSeen = seen(latest.heater_w);
    const collector = seen({ ts: latest.seen });
    const tS = tempState(latest.temp_k ? latest.temp_k.v : null, staleAt(tSeen));
    const pS = pressState(latest.psi ? latest.psi.v : null, staleAt(pSeen));

    box.querySelectorAll(".ps").forEach(n => n.classList.remove("dim"));
    put(".pt-temp", num(latest.temp_k ? latest.temp_k.v : null, 2) ?? "—");
    put(".pt-psi", num(latest.psi ? latest.psi.v : null, 3) ?? "—");
    put(".pt-heat", num(latest.heater_w ? latest.heater_w.v : null, 2) ?? "—");
    if (staleAt(tSeen)) box.querySelector(".ps-temp").classList.add("dim");
    if (staleAt(pSeen)) box.querySelector(".ps-psi").classList.add("dim");
    if (staleAt(hSeen)) box.querySelector(".ps-heat").classList.add("dim");

    if (staleAt(collector)) {
      state("crit", "not updating");
      put(".pt-sub", `Last reading ${esc(collector == null ? "unknown" : ago(Date.now() - collector))} · the lab PC stopped reporting.`);
      return;
    }
    /* the chip carries the wording of whichever reading is worst, in the same words the
       PPMS page uses — "warm" and "off setpoint" say which one drifted, "check it" does not */
    const worst = [{ s: tS, w: { warn: "warm", crit: "too warm" } },
                   { s: pS, w: { warn: "off setpoint", crit: "far off setpoint" } }]
                  .filter(x => x.s).sort((a, b) => RANK[b.s] - RANK[a.s])[0];
    state(worst ? worst.s : null, worst ? (worst.w[worst.s] || "normal") : "");
    const dev = [latest.scm && latest.scm !== "OK" ? "SCM10 " + latest.scm.toLowerCase() : "",
                 latest.hrc && latest.hrc !== "OK" ? "HRC " + latest.hrc.toLowerCase() : ""].filter(Boolean).join(" · ");
    put(".pt-sub", `Updated ${esc(ago(Date.now() - collector))}${latest.src && latest.src !== "LIVE" ? " · demo numbers" : ""}${dev ? " · " + esc(dev) : ""}`);
  }

  window.PPMSLive = { load, seen, staleAt, ago, tempState, pressState, renderTile };

  document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("ppms-tile")) return;
    renderTile();
    /* the collector uploads once a minute; follow it, but never in a background tab */
    setInterval(() => { if (!document.hidden) renderTile(); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) renderTile(); });
  });
})();
