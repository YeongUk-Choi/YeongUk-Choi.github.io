/* Software page: one card per program, built from data/software.js.
   A program nobody can run is not shared, so every card has to answer three things —
   what it does, what it needs, and how to get it. */
(function () {
  const S = (window.SITE || {}).software || {};
  const P = (window.SITE || {}).profile || {};
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KIND = { desktop: "runs on your PC", script: "command line", web: "runs in the browser" };

  /* A card only offers to launch something once that door is actually open:
     data/xrd.js carries the switch, and until it is on the icon and the button
     are plain, not links to a gate that cannot let anyone in. */
  const launchable = (it) => Boolean(it.launch) && Boolean((window.XRD_GATE || {}).enabled);

  function card(it) {
    const prep = it.status === "preparing";
    const links = ((it.links || []).filter((l) => !l.page || launchable(it))).map(l =>
      `<a class="btn small${l.primary ? " primary" : ""}" href="${esc(l.href)}"${/^https?:/.test(l.href) ? ' target="_blank" rel="noopener"' : l.page ? "" : " download"}>${esc(l.label)}</a>`).join("");
    const meta = [it.version && `v${esc(it.version)}`, it.date && esc(it.date), it.license ? esc(it.license) : "ask before reuse"]
      .filter(Boolean).join(" \u00b7 ");
    /* The screen first, then what it does: a reader decides whether to care from the picture,
       and the bullets answer "can it do the thing I came for". */
    /* With a screen to show, the name belongs over it like an app tile; the right-hand
       column then opens straight into what the thing does. */
    const head = `<div class="sw-head">
        ${it.icon ? (launchable(it) ? `<a href="${esc(it.launch)}" aria-label="Open ${esc(it.name)}"><img class="sw-icon" src="${esc(it.icon)}" alt="" width="54" height="54"></a>` : `<img class="sw-icon" src="${esc(it.icon)}" alt="" width="54" height="54">`) : ""}
        <div class="sw-idname">
          <span class="sw-name">${esc(it.name)}</span>
          ${it.sub ? `<span class="sw-sub">${esc(it.sub)}</span>`
                   : it.kind ? `<span class="sw-sub">${esc(KIND[it.kind] || it.kind)}</span>` : ""}
        </div>
        ${prep ? '<span class="st warn">being packaged</span>' : ""}
      </div>`;
    const media = it.image ? `<figure class="sw-shot">
        ${head}
        <a href="${esc(it.image)}" target="_blank" rel="noopener">
          <img src="${esc(it.image)}" alt="${esc(it.imageAlt || it.name)}" loading="lazy"></a>
        ${it.imageNote ? `<figcaption>${esc(it.imageNote)}</figcaption>` : ""}
      </figure>` : "";
    const feats = (it.features || []).length
      ? `<ul class="sw-feat">${it.features.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
    const foot = links || meta || prep
      ? `<div class="sw-foot">${links || (prep && !it.image ? '<span class="subtle">not downloadable yet</span>' : "")}
         ${meta ? `<span class="subtle sw-meta">${meta}</span>` : ""}</div>` : "";
    return `<article class="sw-card${it.image ? " has-shot" : ""}">
      ${media}
      <div class="sw-body">
        ${it.image ? "" : head}
        ${it.tagline ? `<p class="sw-tag">${esc(it.tagline)}</p>` : ""}
        ${feats}
        ${it.what ? `<p class="sw-what">${esc(it.what)}</p>` : ""}
        ${it.needs ? `<p class="sw-needs"><b>Needs</b> ${esc(it.needs)}</p>` : ""}
        ${it.caveat ? `<p class="sw-caveat">${esc(it.caveat)}</p>` : ""}
        ${it.cite ? `<p class="sw-cite"><b>If it helps a paper</b> ${esc(it.cite)}</p>` : ""}
        ${foot}
      </div>
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
