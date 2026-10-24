/* The lab-code gate for the Crystal Phase Viewer.

   The same shared code as XRD Studio, checked the same way: a POST of
   action=xrdcheck to the lab web app, which holds XRD_CODE in Script
   Properties and locks everyone out for ten minutes after five wrong tries.
   The code is never stored here, and nothing but a "this session passed" flag
   is kept.

   What the gate is for: the viewer talks to COD through the lab's Apps Script
   deployment, which is the same deployment that receives the helium
   recondenser telemetry. An open page would spend that project's URL Fetch
   quota on anyone who finds the address. It is not a secrecy measure - COD is
   public data, and the page's code is readable in the browser like every other
   file on this site. */
(function () {
  "use strict";
  const cfg = (window.SITE && window.SITE.phases) || {};
  if (!cfg.gate) return;                  /* the viewer starts itself */

  const $ = s => document.querySelector(s);
  /* This file is loaded in <head> like the rest of the page's scripts, so the
     elements are looked up when the document is ready and not before: at parse
     time every one of these is null. */
  let gate, app, statusLine, input, button;
  const apiUrl = cfg.relayUrl || (window.SITE && window.SITE.ppms && window.SITE.ppms.apiUrl) || "";
  const SESSION = "phase-viewer-open";
  const say = (text, warn) => {
    statusLine.textContent = text || "";
    statusLine.classList.toggle("warn", warn !== false && !!text);
  };
  /* The server answers a refusal in prose; these are the three cases worth
     telling apart, and anything else is reported as it arrived. */
  const refusal = message => {
    if (/too many|lock/i.test(message)) return "코드 오류가 누적되어 잠겼습니다. 10분 후 다시 시도해 주십시오.";
    if (/wrong/i.test(message)) return "공용 코드가 올바르지 않습니다.";
    if (/not set|config|not ready/i.test(message)) return "코드 확인 서비스가 준비되지 않았습니다. 최영욱에게 문의해 주십시오.";
    return message || "코드를 확인하지 못했습니다.";
  };

  function open() {
    gate.hidden = true;
    app.hidden = false;
    try { sessionStorage.setItem(SESSION, "1"); } catch (e) { /* private mode: this tab only */ }
    window.PhaseViewer.start();
  }

  /* Ending the session reloads rather than re-hiding: the viewer holds the
     parsed structures and the drawing in memory, and only a fresh document
     actually gives them up. */
  function end() {
    try { sessionStorage.removeItem(SESSION); } catch (e) { /* nothing kept */ }
    location.reload();
  }

  document.addEventListener("DOMContentLoaded", () => {
    gate = $("#pv-gate"); app = $("#pv-app");
    statusLine = $("#pv-gate-status"); input = $("#pv-code"); button = $("#pv-gate-go");
    let passed = false;
    try { passed = sessionStorage.getItem(SESSION) === "1"; } catch (e) { passed = false; }
    if (passed) { open(); return; }

    gate.hidden = false;
    if (!apiUrl) {
      input.disabled = button.disabled = true;
      say("코드 확인 서비스 주소가 설정되지 않았습니다. 최영욱에게 문의해 주십시오.");
      return;
    }
    $("#pv-gate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value;
      input.value = "";
      button.disabled = input.disabled = true;
      say("코드를 확인하고 있습니다…", false);
      try {
        const r = await fetch(apiUrl, {
          method: "POST", body: new URLSearchParams({ action: "xrdcheck", code }),
          cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(30000)
        });
        if (!r.ok) throw new Error(`코드 확인 서비스가 HTTP ${r.status}을 돌려주었습니다.`);
        const j = await r.json();
        if (!j || j.ok !== true) throw new Error(refusal(String((j && j.error) || "")));
        say("");
        open();
      } catch (err) {
        say(err && err.message ? err.message : "코드 확인 서비스에 연결하지 못했습니다.");
      } finally {
        button.disabled = input.disabled = false;
      }
    });
    input.focus();
  });

  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "pv-lock") end();
  });
})();
