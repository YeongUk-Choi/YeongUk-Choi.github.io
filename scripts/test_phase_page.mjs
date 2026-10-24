#!/usr/bin/env node
/* node scripts/test_phase_page.mjs [--chrome PATH]

   Drives phases.html in a private headless Chrome against a loopback server:
   the lab-code gate, the composition + space-group-number search, and the
   relay path. Nothing production is touched - the page is served from this
   checkout with a test data/phases.js, the relay is this file, and Chrome is
   started with every name but 127.0.0.1 resolving nowhere, so a request to
   the real lab web app or to COD fails instead of leaving the machine.

   The one thing this cannot prove is Google-hosted execution of the Apps
   Script half; scripts/apps-script/test_cod_proxy.cjs covers that handler, and
   COD_PROXY.md lists what only a deployment can show. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readFileSync } from "node:fs";
import { mkdtemp, rm, readFile as read } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const chromePath = (args.indexOf("--chrome") >= 0 && args[args.indexOf("--chrome") + 1])
  || process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CODE = "test-lab-code";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Real records with real CIFs, so what the page draws is a structure and not a
   fixture that only looks like one. */
const cache = JSON.parse(readFileSync(path.join(root, "data/phases/VO2.json"), "utf8"));
const asCodRow = e => ({
  file: String(e.cod_id), formula: e.formula, sg: e.spacegroup, sgNumber: e.sg_number,
  a: String(e.a), b: String(e.b), c: String(e.c),
  alpha: String(e.alpha), beta: String(e.beta), gamma: String(e.gamma), vol: String(e.volume)
});

/* How the relay behaves is switched per test. "ignore-sg" is COD's own
   behaviour for a parameter it does not accept: the filter is dropped and the
   whole search comes back, which is exactly the case the page has to catch. */
let relayMode = "filter";
const calls = { xrdcheck: 0, cod: [], cif: [] };

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const TEST_CONFIG = port => `window.SITE = window.SITE || {};
window.SITE.phases = { relayUrl: "http://127.0.0.1:${port}/relay", live: true, gate: true };`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, type, body) => { res.writeHead(code, { "content-type": type }); res.end(body); };

  if (url.pathname === "/relay") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        const form = new URLSearchParams(body);
        calls.xrdcheck++;
        if (form.get("action") !== "xrdcheck") return send(200, "application/json", JSON.stringify({ ok: false, error: "Unknown action." }));
        send(200, "application/json", form.get("code") === CODE
          ? JSON.stringify({ ok: true })
          : JSON.stringify({ ok: false, error: "Wrong code." }));
      });
      return;
    }
    const action = url.searchParams.get("action");
    if (action === "cif") {
      const id = url.searchParams.get("id");
      calls.cif.push(id);
      const hit = cache.entries.find(e => String(e.cod_id) === String(id));
      return hit ? send(200, "text/plain", hit.cif)
        : send(200, "application/json", JSON.stringify({ ok: false, code: "UPSTREAM_INVALID", error: "no such record", retryable: false }));
    }
    if (action === "cod") {
      const sg = url.searchParams.get("sg");
      calls.cod.push({ formula: url.searchParams.get("formula"), sg, url: req.url });
      const n = sg == null ? null : Number(sg);
      const rows = cache.entries
        .filter(e => relayMode === "ignore-sg" || n == null || e.sg_number === n)
        .map(asCodRow);
      return send(200, "application/json", JSON.stringify({
        ok: true, status: rows.length ? "ok" : "empty", formula: url.searchParams.get("formula"),
        sg_number: n, query_mode: n ? "exact_formula+space_group_number" : "exact_formula",
        count: rows.length, records: rows, fetched_at: new Date().toISOString(), cached: false,
        source_url: "https://www.crystallography.net/cod/result?format=json"
      }));
    }
    return send(200, "application/json", JSON.stringify({ ok: false, error: "Unknown action." }));
  }

  if (url.pathname === "/data/phases.js") return send(200, "text/javascript", TEST_CONFIG(server.address().port));
  const file = path.join(root, url.pathname.replace(/^\/+/, ""));
  if (!file.startsWith(root)) return send(403, "text/plain", "no");
  readFile(file, (err, data) => err ? send(404, "text/plain", "not found")
    : send(200, types[path.extname(file)] || "application/octet-stream", data));
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const page = `http://127.0.0.1:${port}/phases.html`;
const profile = await mkdtemp("/private/tmp/phase-page-test-");

const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

let list;
for (let i = 0; i < 40 && !list; i++) {
  await sleep(250);
  try {
    const ports = await read(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => null);
    if (ports) list = await (await fetch(`http://127.0.0.1:${Number(ports.split("\n")[0])}/json`)).json();
  } catch { /* chrome is still starting */ }
}
assert(list, "headless Chrome did not start");
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP socket failed")); });
let id = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(resolve => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "page threw");
  return r.result?.result?.value;
};
const text = sel => run(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent || ""`);
const shown = sel => run(`!!document.querySelector(${JSON.stringify(sel)}) && !document.querySelector(${JSON.stringify(sel)}).hidden`);
const open = async () => { await send("Page.navigate", { url: page }); await sleep(900); };
/* The page answers a search asynchronously; wait for the line it writes
   rather than for a fixed delay. */
async function waitStatus(match, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const s = await text("#pv-status");
    /* "...중…" is the line the page writes while it is still fetching; it can
       contain everything the final line contains. */
    if (!/중…$|중…\s*\(/.test(s) && match.test(s)) return s;
    await sleep(100);
  }
  return await text("#pv-status");
}
const search = async (formula, sg = "") => {
  await run(`(() => { const f = document.querySelector("#pv-input"), s = document.querySelector("#pv-sg");
    f.value = ${JSON.stringify(formula)}; s.value = ${JSON.stringify(sg)};
    document.querySelector("#pv-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true})); })()`);
};
const enterCode = async (code) => {
  await run(`(() => { document.querySelector("#pv-code").value = ${JSON.stringify(code)};
    document.querySelector("#pv-gate-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true})); })()`);
  await sleep(500);
};

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + (detail ? "  -> " + detail : "")); }
};

try {
  await send("Page.enable");
  await send("Runtime.enable");

  console.log("the lab code comes first");
  await open();
  ok("the gate is shown and the viewer is not", await shown("#pv-gate") && !(await shown("#pv-app")));
  ok("nothing is asked of the relay before the code", calls.cod.length === 0 && calls.cif.length === 0,
    JSON.stringify(calls));
  ok("the composition box does not exist to be typed in yet",
    await run(`!!document.querySelector("#pv-app").hidden`));

  await enterCode("not-the-code");
  ok("a wrong code is refused in the reader's language", /올바르지 않습니다/.test(await text("#pv-gate-status")),
    await text("#pv-gate-status"));
  ok("a wrong code leaves the viewer closed", !(await shown("#pv-app")));
  ok("a wrong code does not start a COD search", calls.cod.length === 0);

  await enterCode(CODE);
  ok("the right code opens the viewer", await shown("#pv-app") && !(await shown("#pv-gate")));
  ok("the code is checked at the lab web app, once per try", calls.xrdcheck === 2, String(calls.xrdcheck));

  console.log("composition and space group number");
  let line = await waitStatus(/후보|없습니다/);
  ok("the committed VO2 cache is read without the relay", /COD 레코드 11건/.test(line) && calls.cod.length === 0, line);

  await search("VO2", "14");
  line = await waitStatus(/공간군 14번/);
  ok("a number filters the committed cache and says what it filtered",
    /COD 레코드 11건 중 공간군 14번 2건 → 유사 격자 후보 1개/.test(line), line);
  ok("only the matching candidate is listed", await run(`document.querySelectorAll("#pv-list .pv-row").length`) === 1,
    String(await run(`document.querySelectorAll("#pv-list .pv-row").length`)));
  ok("the listed candidate is the one that was asked for",
    /21\/c/.test(await text("#pv-list")), await text("#pv-list"));

  await search("VO2", "1");
  line = await waitStatus(/공간군 1번/);
  ok("a composition without that space group says so, and says what it does have",
    /공간군 1번은 없습니다/.test(line) && /이 조성에 있는 번호: 2, 10, 12, 14, 62, 136/.test(line), line);
  ok("an empty filter result is marked as a warning, not a result", await run(`document.querySelector("#pv-status").classList.contains("warn")`));

  const before = calls.cod.length;
  await search("VO2", "P21/c");
  await sleep(300);
  line = await text("#pv-status");
  ok("a space group symbol is refused as a typing mistake", /1부터 230까지의 정수/.test(line), line);
  ok("a refused number asks COD nothing", calls.cod.length === before);

  console.log("a composition nobody fetched in advance");
  await search("TiO2", "136");
  line = await waitStatus(/즉석 검색|되지 않았습니다/);
  ok("the relay is asked, with the number as its own parameter",
    calls.cod.length === 1 && calls.cod[0].sg === "136", JSON.stringify(calls.cod));
  /* Four rutile records in the committed cache, one lattice: the relayed line
     counts records and the grouping counts candidates, and they differ. */
  ok("a relayed search reports what it counted and where it came from",
    /공간군 136번 COD 레코드 4건 → 유사 격자 후보 1개 \(COD 즉석 검색\)/.test(line), line);

  await run(`document.querySelectorAll("#pv-list input[type=checkbox]")[0].click()`);
  for (let i = 0; i < 40 && !(await run(`document.querySelectorAll("#pv-figure svg").length`)); i++) await sleep(100);
  ok("ticking a relayed record fetches its CIF and draws it",
    calls.cif.length === 1 && (await run(`document.querySelectorAll("#pv-figure svg").length`)) === 1,
    JSON.stringify(calls.cif));

  console.log("an upstream that ignores the filter cannot pass as a filtered answer");
  /* COD answers space_group_number=999 or =abc with the unfiltered search.
     The relay refuses those values, but an upstream that silently stops
     honouring the parameter would look identical to a narrow result. */
  relayMode = "ignore-sg";
  await search("TiO2", "14");
  line = await waitStatus(/공간군 14번/);
  ok("records the relay should not have sent are dropped here",
    /공간군 14번 COD 레코드 2건/.test(line), line);
  ok("the figure cannot show a phase outside the filter",
    await run(`document.querySelectorAll("#pv-list .pv-row").length`) === 1);
  relayMode = "filter";

  console.log("ending and resuming a session");
  await run(`document.querySelector("#pv-lock").click()`);
  await sleep(900);
  ok("ending the session puts the gate back", await shown("#pv-gate") && !(await shown("#pv-app")));
  ok("ending the session discards the drawing with the document",
    (await run(`document.querySelectorAll("#pv-figure svg").length`)) === 0);
  await enterCode(CODE);
  await open();
  ok("a passed code lasts the tab, without asking again", await shown("#pv-app") && !(await shown("#pv-gate")));
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(400);                        /* Chrome is still writing its profile */
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
