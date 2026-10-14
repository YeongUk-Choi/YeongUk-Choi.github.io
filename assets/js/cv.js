/* CV 페이지 렌더러. 사이트의 다른 페이지와 같은 data/*.js를 읽습니다 — 논문을 추가하면 CV도 따라 바뀝니다. */
(function () {
  const S = window.SITE || {}, P = S.profile || {}, C = S.cv || {};
  const $ = s => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ME = /(YeongUk Choi|Yeong Uk Choi|Yeong-Uk Choi|CHOI Yeong Uk|Y\. U\. Choi|YU Choi)/g;

  /* ---- 머리 ---- */
  $("#cv-name").textContent = P.name || "";
  $("#cv-role").textContent = P.title || "";
  $("#cv-aff").textContent = [P.affiliation, P.labs].filter(Boolean).join(" · ");
  const contact = $("#cv-contact");
  if (P.email) contact.append(Object.assign(el("a", null, esc(P.email)), { href: "mailto:" + P.email }));
  if (P.siteUrl) contact.append(Object.assign(el("a", null, esc(P.siteUrl.replace(/^https?:\/\//, ""))), { href: P.siteUrl }));
  if (P.scholarUrl) contact.append(Object.assign(el("a", null, "Google Scholar"), { href: P.scholarUrl }));
  if (P.orcid) contact.append(Object.assign(el("a", null, "ORCID " + esc(P.orcid)), { href: "https://orcid.org/" + P.orcid }));
  const photo = $("#cv-photo");
  const shot = typeof C.photo === "string" ? C.photo : (P.photo || (P.photos || [])[0]);
  if (C.photo && shot) photo.src = shot; else photo.remove();

  /* ---- 학력 ---- */
  (C.education || []).forEach(e => {
    const r = el("div", "row");
    r.append(el("div", "when", esc([e.from, e.to].filter(Boolean).join(" – "))));
    const w = el("div", "what");
    w.append(el("div", null, `<b>${esc(e.degree)}</b>`));
    if (e.org) w.append(el("div", "sub", esc(e.org)));
    if (e.note) w.append(el("div", "sub2", esc(e.note)));
    r.append(w); $("#cv-edu").append(r);
  });

  /* ---- 수상 ---- */
  const awards = C.awards || [];
  if (!awards.length) $("#sec-awards").remove();
  awards.forEach(a => {
    const r = el("div", "row");
    r.append(el("div", "when", esc(a.date || a.year || "")));
    const w = el("div", "what");
    w.append(el("div", null, `<b>${esc(a.name)}</b>`));
    w.append(el("div", "sub", esc([a.org, a.note].filter(Boolean).join(" · "))));
    if (a.detail) w.append(el("div", "quote", `“${esc(a.detail)}”`));
    r.append(w); $("#cv-awards").append(r);
  });

  /* ---- 논문: 고정(featured) 먼저, 그다음 연도 내림차순 ---- */
  const rank = p => p.featured ? (typeof p.featured === "number" ? p.featured : 1) : Infinity;
  const pubs = (S.publications || []).filter(p => !p.placeholder)
    .slice().sort((a, b) => (rank(a) - rank(b)) || (b.year - a.year));
  $("#cv-pub-n").textContent = pubs.length;
  pubs.forEach((p, i) => {
    const row = el("div", "pub");
    row.append(el("div", "pub-n", String(i + 1) + "."));
    const b = el("div");
    b.append(el("div", "pub-t", esc(p.title) + (p.featured ? '<span class="sel">selected</span>' : "")));
    if (p.authors) b.append(el("div", "pub-a", esc(p.authors).replace(ME, "<u>$1</u>")));
    const ref = [p.journal ? `<b>${esc(p.journal)}</b>` : "", p.volume ? esc(p.volume) : "",
                 p.page ? esc(p.page) : "", p.year ? `(${p.year})` : ""].filter(Boolean).join(" ");
    const r = el("div", "pub-r", ref);
    if (p.doi) { r.append(document.createTextNode(" · ")); r.append(Object.assign(el("a", "doi", "doi:" + esc(p.doi)), { href: "https://doi.org/" + p.doi })); }
    b.append(r); row.append(b); $("#cv-pubs").append(row);
  });

  /* ---- 역량: measurements.js를 성격별로 묶음 ---- */
  const meas = S.measurements || [];
  const pick = kind => meas.filter(m => m.kind === kind);
  const line = m => `<b>${esc(m.name.replace(/\s*—.*$/, ""))}</b>${m.cond ? ` (${esc(m.cond)})` : ""} — ${esc(m.cvDetail || m.detail)}`;
  const mats = (S.materials || []).map(m => m.label).join(" · ");
  const skills = [
    ["Measurement", pick("measurement").map(line)],
    ["Growth", pick("synthesis").map(line)],
    ["Analysis & software", pick("analysis").map(line)],
    ["Materials grown", mats ? [esc(mats)] : []]
  ];
  skills.forEach(([k, lines]) => {
    if (!lines.length) return;
    const r = el("div", "skill");
    r.append(el("div", "k", esc(k)));
    r.append(el("div", "v", lines.join("<br>")));
    $("#cv-skills").append(r);
  });

  /* ---- 현재 연구: focus.js 본문의 첫 문단 ---- */
  const md = (S.focusMarkdown || "").trim().split("\n").filter(l => !l.startsWith("#"));
  const para = md.join("\n").trim().split(/\n\s*\n/)[0] || "";
  $("#cv-focus-line").textContent = S.focusLine || "";
  $("#cv-focus-text").textContent = para.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!S.focusLine && !para) $("#sec-focus").remove();

  /* ---- 꼬리 ---- */
  $("#cv-updated").textContent = C.updated || "";
})();
