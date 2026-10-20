/* Software page: one card per program, built from data/software.js.
   A program nobody can run is not shared, so every card has to answer three things —
   what it does, what it needs, and how to get it. */
(function () {
  const S = (window.SITE || {}).software || {};
  const P = (window.SITE || {}).profile || {};
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KIND = { desktop: "runs on your PC", script: "command line", web: "runs in the browser" };

  function card(it) {
    const prep = it.status === "preparing";
    const links = (it.links || []).map(l =>
      `<a class="btn small${l.primary ? " primary" : ""}" href="${esc(l.href)}"${/^https?:/.test(l.href) ? ' target="_blank" rel="noopener"' : " download"}>${esc(l.label)}</a>`).join("");
    const meta = [it.version && `v${esc(it.version)}`, it.date && esc(it.date), it.license ? esc(it.license) : "ask before reuse"]
      .filter(Boolean).join(" · ");
    return `<article class="sw-card">
      <div class="sw-top">
        <h2>${esc(it.name)}</h2>
        ${prep ? '<span class="st warn">being packaged</span>' : it.kind ? `<span class="sw-kind">${esc(KIND[it.kind] || it.kind)}</span>` : ""}
      </div>
      ${it.tagline ? `<p class="sw-tag">${esc(it.tagline)}</p>` : ""}
      ${it.what ? `<p class="sw-what">${esc(it.what)}</p>` : ""}
      ${it.needs ? `<p class="sw-needs"><b>Needs</b> ${esc(it.needs)}</p>` : ""}
      ${it.caveat ? `<p class="sw-caveat">${esc(it.caveat)}</p>` : ""}
      ${it.cite ? `<p class="sw-cite"><b>If it helps a paper</b> ${esc(it.cite)}</p>` : ""}
      <div class="sw-foot">${links || (prep ? '<span class="subtle">not downloadable yet</span>' : "")}
        ${meta ? `<span class="subtle sw-meta">${meta}</span>` : ""}</div>
    </article>`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const box = document.getElementById("sw-list");
    if (!box) return;
    const lede = document.getElementById("sw-lede");
    if (lede && S.lede) lede.textContent = S.lede;
    const items = S.items || [];
    /* An empty page should say it is empty on purpose, not look broken. */
    box.innerHTML = items.length ? items.map(card).join("")
      : `<div class="sw-empty"><b>Nothing to download yet.</b>
         <p>The first programs are being packaged. If you need one of my analysis or
         instrument-control scripts before then, ask and I will send it.</p>
         <a class="btn small primary" href="mailto:${esc(P.email || "")}">Email me</a></div>`;
    const n = document.getElementById("sw-count");
    if (n) n.textContent = items.length || "";
  });
})();
