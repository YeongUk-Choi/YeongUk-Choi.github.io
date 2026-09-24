/* Shared renderers. Each page calls the function it needs. Data comes from window.SITE (data/*.js). */
(function () {
  const S = window.SITE || {};
  const P = S.profile || {};
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---- nav + footer + profile fields ---- */
  function renderChrome() {
    const page = document.body.dataset.page;
    document.querySelectorAll(".nav-links a").forEach(a => { if (a.dataset.page === page) a.classList.add("active"); });
    document.querySelectorAll("[data-profile]").forEach(n => {
      const key = n.dataset.profile; const v = P[key];
      if (v == null || v === "") { if (n.dataset.hideEmpty !== undefined) n.style.display = "none"; return; }
      if (n.tagName === "IMG") n.src = v; else n.textContent = v;
    });
    document.querySelectorAll("[data-profile-aff]").forEach(n => { n.textContent = [P.affiliation, P.labs].filter(Boolean).join(" · "); });
    document.querySelectorAll("[data-profile-points]").forEach(ul => {
      (P.heroPoints || []).forEach(pt => { const li = document.createElement("li"); const lines = Array.isArray(pt.v) ? pt.v : [pt.v]; li.innerHTML = `<b>${esc(pt.k)}</b><span>${lines.map(esc).join("<br>")}</span>`; ul.append(li); });
    });
    document.querySelectorAll("[data-profile-hero]").forEach(n => { if (P.hero) n.innerHTML = esc(P.hero).replace(/—/g, "<br class=\"hero-br\">—"); });
    const pillDot = $(".pill .dot"); if (pillDot && !P.nowAvailable) pillDot.classList.add("off");
    document.querySelectorAll("[data-book]").forEach(b => {
      if (P.bookingUrl) { b.href = P.bookingUrl; b.target = "_blank"; b.rel = "noopener"; }
      else { b.setAttribute("aria-disabled", "true"); b.title = "Booking link not set yet"; }
    });
    document.querySelectorAll("[data-mail]").forEach(b => { if (P.email) b.href = "mailto:" + P.email; else b.style.display = "none"; });
    const y = $("[data-year]"); if (y) y.textContent = new Date().getFullYear();
    rotatePhotos();
  }

  /* ---- hero photo slideshow: fade out → swap src → fade in, every P.photoInterval ms ---- */
  function rotatePhotos() {
    const photos = (P.photos || []).filter(Boolean);
    const imgs = [...document.querySelectorAll('img[data-profile="photo"]')];
    if (photos.length < 2 || !imgs.length) return;
    photos.forEach(src => { const i = new Image(); i.src = src; });      // preload so the swap never flashes empty
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    imgs.forEach(img => { img.src = photos[0]; img.classList.add("photo-fade"); });
    let idx = 0;
    const swap = () => {
      if (document.hidden) return;                                       // don't advance in a background tab
      idx = (idx + 1) % photos.length;
      if (still) { imgs.forEach(img => { img.src = photos[idx]; }); return; }
      imgs.forEach(img => img.classList.add("is-out"));
      setTimeout(() => { imgs.forEach(img => { img.src = photos[idx]; img.classList.remove("is-out"); }); }, 450);
    };
    setInterval(swap, Math.max(1500, +P.photoInterval || 5000));
  }

  /* ---- home bento numbers ---- */
  function renderHome() {
    const meas = S.measurements || [], pubs = (S.publications || []).filter(p => !p.placeholder), mats = S.materials || [];
    $("#n-meas").textContent = meas.length;
    $("#n-pubs").textContent = pubs.length || "—";
    $("#n-pubs-sub").textContent = pubs.length ? "peer-reviewed papers · from Google Scholar" : "list not loaded yet";
    const next = upcomingEvents(1)[0];
    $("#n-sched").textContent = next ? fmtRange(next) : "—";
    const sub = $("#n-sched-sub"); if (sub) sub.textContent = next ? next.title : "no dates marked yet";
    $("#n-mats").textContent = mats.length;
    $("#focus-line").textContent = S.focusLine || "";
    $("#meas-sub").textContent = meas.filter(m => m.featured).map(m => m.name).join(" · ");
    // mini bond motif for materials tile
    const now = mats.find(m => m.now) || mats[0];
    if (now) $("#mats-sub").textContent = "now: " + now.label;
  }

  /* ---- measurements ---- */
  function renderMeasurements() {
    const list = $("#meas-list"); const items = S.measurements || [];
    items.forEach((m, i) => {
      const r = el("div", "row" + (m.featured ? " featured" : ""));
      r.append(el("div", "idx", String(i + 1).padStart(2, "0")));
      const mid = el("div");
      mid.append(el("div", "name", esc(m.name) + (m.service ? ' <span class="badge">Available on request</span>' : "")),
                 el("div", "detail", esc(m.detail) + (m.sample ? ` <span class="subtle">· ${esc(m.sample)}</span>` : "")));
      r.append(mid, el("div", "cond", esc(m.cond)));
      list.append(r);
    });
    $("#meas-count").textContent = items.length;
  }

  /* ---- publications ---- */
  function renderPublications() {
    const list = $("#pub-list");
    const rank = p => p.featured ? (typeof p.featured === "number" ? p.featured : 1) : Infinity; // featured: 1,2,3 = pinned order
    const pubs = (S.publications || []).slice().sort((a, b) => (rank(a) - rank(b)) || (b.year - a.year));
    const meta = S.publicationsMeta || {};
    const real = pubs.filter(p => !p.placeholder);
    $("#pub-count").textContent = real.length || "—";
    $("#pub-src").textContent = meta.source === "scholar" ? `From Google Scholar · abstracts via Crossref/OpenAlex · updated ${meta.updated}`
      : meta.source === "orcid" ? `Synced from ORCID · ${meta.updated}` : "Placeholder list";
    let year = null;
    pubs.forEach(p => {
      if (!p.featured && p.year !== year) { year = p.year; list.append(el("div", "year-head", String(year))); }
      const card = el("article", "pub-card" + (p.featured ? " featured" : "") + (p.placeholder ? " placeholder" : ""));
      if (p.image) { const fig = el("figure", "pub-fig"); fig.innerHTML = `<img src="${esc(p.image)}" alt="" loading="lazy">${p.imageCaption || p.imageCredit ? `<figcaption>${esc(p.imageCaption)}${p.imageCredit ? ` · ${esc(p.imageCredit)}` : ""}</figcaption>` : ""}`; card.append(fig); }
      const body = el("div", "pub-body");
      const ref = [p.journal, p.volume ? `<b>${esc(p.volume)}</b>` : "", p.volume && p.page ? esc(p.page) : "", p.year ? `(${p.year})` : ""].filter(Boolean).join(" ");
      if (p.featured) body.append(el("div", "pub-pin", "Selected"));
      body.append(el("h3", "pub-title", esc(p.title)));
      if (p.authors) body.append(el("div", "pub-authors", esc(p.authors).replace(/(YeongUk Choi|Yeong Uk Choi|Yeong-Uk Choi|Y\. U\. Choi|YU Choi)/g, "<u>$1</u>")));
      body.append(el("div", "pub-ref", ref));
      const foot = el("div", "pub-foot");
      if (p.abstract) {
        const d = document.createElement("details"); d.className = "pub-abs";
        d.innerHTML = `<summary>Abstract</summary><p>${esc(p.abstract)}</p>`; foot.append(d);
      } else foot.append(el("span", "subtle", "Abstract not available from publisher"));
      if (p.doi) foot.append(Object.assign(el("a", "btn small", "DOI ↗"), { href: "https://doi.org/" + p.doi, target: "_blank", rel: "noopener" }));
      body.append(foot); card.append(body); list.append(card);
    });
    const links = $("#pub-links");
    if (P.scholarUrl) links.append(Object.assign(el("a", "btn", "Google Scholar ↗"), { href: P.scholarUrl, target: "_blank", rel: "noopener" }));
    if (P.orcid) links.append(Object.assign(el("a", "btn", "ORCID ↗"), { href: "https://orcid.org/" + P.orcid, target: "_blank", rel: "noopener" }));
  }

  /* ---- schedule: monthly calendar (data/schedule.js) ---- */
  const SCH = S.schedule || {}; const EVENTS = (SCH.events || []).map(e => ({ ...e, s: pd(e.start), e: pd(e.end || e.start) })).filter(e => e.s && e.e);
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function pd(str) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
  function fmtRange(ev) {
    const m = d => MONTHS[d.getMonth()].slice(0, 3);
    if (sameDay(ev.s, ev.e)) return `${m(ev.s)} ${ev.s.getDate()}`;
    if (ev.s.getMonth() === ev.e.getMonth()) return `${m(ev.s)} ${ev.s.getDate()}–${ev.e.getDate()}`;
    return `${m(ev.s)} ${ev.s.getDate()} – ${m(ev.e)} ${ev.e.getDate()}`;
  }
  function upcomingEvents(n) { const t = today(); return EVENTS.filter(ev => ev.e >= t).sort((a, b) => a.s - b.s).slice(0, n || EVENTS.length); }
  let calY, calM;
  function renderMonth(y, m) {
    calY = y; calM = m;
    const ws = +SCH.weekStart || 0; const t = today();
    $("#cal-title").textContent = `${MONTHS[m]} ${y}`;
    const dow = $("#cal-dow"); dow.innerHTML = ""; for (let i = 0; i < 7; i++) dow.append(el("div", "", DOW[(i + ws) % 7]));
    const grid = $("#cal-grid"); grid.innerHTML = "";
    const first = new Date(y, m, 1); const lead = (first.getDay() - ws + 7) % 7; const days = new Date(y, m + 1, 0).getDate();
    const cells = Math.ceil((lead + days) / 7) * 7;
    for (let i = 0; i < cells; i++) {
      const d = new Date(y, m, i - lead + 1); const inMonth = d.getMonth() === m;
      const c = el("div", "cal-cell" + (inMonth ? "" : " out") + (sameDay(d, t) ? " today" : "") + (d.getDay() === 0 ? " sun" : ""));
      c.append(el("div", "n", d.getDate()));
      EVENTS.filter(ev => d >= ev.s && d <= ev.e).forEach(ev => {
        const startsHere = sameDay(d, ev.s) || i % 7 === 0;
        const chip = el("div", "ev " + (ev.kind || "event") + (startsHere ? "" : " cont") + (sameDay(d, ev.e) ? " last" : ""), startsHere ? esc(ev.title) : "&nbsp;");
        chip.title = `${ev.title} · ${fmtRange(ev)}`; c.append(chip);
      });
      grid.append(c);
    }
  }
  function renderSchedule() {
    const t = today(); renderMonth(t.getFullYear(), t.getMonth());
    $("[data-cal-prev]").onclick = () => renderMonth(calM === 0 ? calY - 1 : calY, (calM + 11) % 12);
    $("[data-cal-next]").onclick = () => renderMonth(calM === 11 ? calY + 1 : calY, (calM + 1) % 12);
    const list = $("#cal-list"); const up = upcomingEvents();
    if (!up.length) list.append(el("li", "cal-item empty", "Nothing marked yet — every day is open by appointment."));
    up.forEach(ev => {
      const li = el("li", "cal-item " + (ev.kind || "event"));
      li.innerHTML = `<span class="when">${esc(fmtRange(ev))}<small>${ev.s.getFullYear()}</small></span><span class="what"><b>${esc(ev.title)}</b>${ev.note ? `<span class="note">${esc(ev.note)}</span>` : ""}</span>`;
      li.onclick = () => renderMonth(ev.s.getFullYear(), ev.s.getMonth()); list.append(li);
    });
    const box = $("#cal-embed");
    if (P.calendarEmbedUrl) { const f = document.createElement("iframe"); f.src = P.calendarEmbedUrl; f.loading = "lazy"; box.innerHTML = ""; box.append(f); box.hidden = false; }
  }

  /* ---- focus: tiny markdown ---- */
  function md(src) {
    const lines = src.trim().split(/\r?\n/); let out = "", inList = false, para = [];
    const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
    const flush = () => { if (para.length) { out += `<p>${inline(para.join(" "))}</p>`; para = []; } };
    const closeList = () => { if (inList) { out += "</ul>"; inList = false; } };
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) { flush(); closeList(); continue; }
      let m;
      if ((m = l.match(/^(#{1,3})\s+(.*)/))) { flush(); closeList(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
      else if ((m = l.match(/^[-*]\s+(.*)/))) { flush(); if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(m[1])}</li>`; }
      else para.push(l);
    }
    flush(); closeList(); return out;
  }
  function renderFocus() { $("#focus-body").innerHTML = md(S.focusMarkdown || ""); }

  window.Site = { renderChrome, renderHome, renderMeasurements, renderPublications, renderSchedule, renderFocus, renderMonth };
  document.addEventListener("DOMContentLoaded", () => {
    renderChrome();
    const page = document.body.dataset.page;
    ({ home: renderHome, measurements: renderMeasurements, publications: renderPublications, schedule: renderSchedule, focus: renderFocus }[page] || (() => {}))();
  });
})();
