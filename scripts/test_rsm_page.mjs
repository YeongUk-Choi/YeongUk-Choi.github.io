#!/usr/bin/env node
/* Real-page checks in an isolated headless Chrome profile, using this checkout
   and a loopback-only synthetic code-check endpoint. No production endpoint or
   interactive browser is touched. Delayed File.text() controls only timing;
   the actual uploaded File bytes and shipped parser/worker/UI execute normally.
   Usage: node scripts/test_rsm_page.mjs [--chrome PATH] [--output DIR] */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const chromePath = option("--chrome", process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const output = path.resolve(option("--output", path.join(root, "../../.scratch/RSM_BROWSER_REVIEW")));
const require = createRequire(import.meta.url);
const examples = require("../data/rsm-examples.js");
const temp = await mkdtemp("/private/tmp/rsm-page-test-");
const downloads = path.join(temp, "downloads");
await mkdir(downloads);
await mkdir(output, { recursive: true });
const records = [], pageErrors = [], blocked = [], requests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, socket, server, context, cdp, run, origin;
let gateCalls = 0, workerDelayMs = 0;
const code = "rsm-isolated-test-code";
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
async function check(name, task) {
  try { await task(); records.push({ name, pass: true }); console.log("PASS " + name); }
  catch (error) { records.push({ name, pass: false, error: error.message }); console.error("FAIL " + name + ": " + error.message); }
}
async function poll(expression, message, milliseconds = 12000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { const value = await run(expression); if (value) return value; await delay(80); }
  throw new Error(message + "; status=" + await run("document.getElementById('status')?.textContent"));
}
const ready = () => poll("!document.getElementById('export-png').disabled && document.getElementById('reflections').children.length > 0", "map did not become exportable");
const input = (id, value, event = "input") => run("(() => { const el=document.getElementById(" + JSON.stringify(id) + "); el.value=" + JSON.stringify(String(value)) + "; el.dispatchEvent(new Event(" + JSON.stringify(event) + ",{bubbles:true})); })()");
const click = id => run("document.getElementById(" + JSON.stringify(id) + ").click()");
async function upload(selector, file) {
  const doc = await cdp("DOM.getDocument");
  const node = await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  await cdp("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [file] });
}
async function readDownload(name) {
  for (let i = 0; i < 80; i++) {
    try { return await readFile(path.join(downloads, name)); } catch { await delay(75); }
  }
  throw new Error("download did not complete: " + name);
}
async function screenshot(name, fullPage = false) {
  const metrics = await cdp("Page.getLayoutMetrics");
  const size = metrics.cssContentSize || metrics.contentSize;
  const options = fullPage ? { clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }, captureBeyondViewport: true } : {};
  const shot = await cdp("Page.captureScreenshot", { format: "png", ...options });
  await writeFile(path.join(output, name), Buffer.from(shot.data, "base64"));
}
const demo = async () => { await click("demo"); await ready(); };
async function delayedSettings(file) {
  await run("(() => { window.__rsmOriginalFileText ||= File.prototype.text; File.prototype.text=function(){ if(this.name==='delayed-settings.json'){const file=this;return new Promise(resolve=>{window.__rsmReleaseSettings=()=>window.__rsmOriginalFileText.call(file).then(resolve);});} return window.__rsmOriginalFileText.call(this); }; })()");
  await upload("#load-session", file);
  await poll("typeof window.__rsmReleaseSettings==='function'", "delayed File.text did not start");
}

try {
  await writeFile(path.join(output, "test-state.json"), JSON.stringify({
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    startedAt: new Date().toISOString()
  }, null, 2));
  server = createServer(async (req, res) => {
    const url = new URL(req.url, origin || "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname });
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
    if (url.pathname === "/test-relay" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body); gateCalls++;
      return send(200, "application/json", JSON.stringify(form.get("action") === "xrdcheck" && form.get("code") === code ? { ok: true } : { ok: false, error: "Wrong code." }));
    }
    if (req.method !== "GET") return send(405, "text/plain", "local test allows no uploads");
    if (url.pathname === "/data/phases.js") return send(200, "text/javascript", "window.SITE=window.SITE||{};window.SITE.phases={relayUrl:" + JSON.stringify(origin + "/test-relay") + ",gate:true};");
    const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) return send(403, "text/plain", "no");
    try {
      const data = await readFile(file);
      if (url.pathname === "/assets/js/rsm-worker.js" && workerDelayMs) await delay(workerDelayMs);
      send(200, mime[path.extname(file)] || "application/octet-stream", data);
    } catch { send(404, "text/plain", "not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = "http://127.0.0.1:" + server.address().port;
  chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--remote-debugging-port=0", "--user-data-dir=" + path.join(temp, "profile"), "about:blank"], { stdio: "ignore" });
  let tabs;
  for (let i = 0; i < 60 && !tabs; i++) {
    await delay(100);
    try { const port = Number((await readFile(path.join(temp, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]); tabs = await (await fetch("http://127.0.0.1:" + port + "/json")).json(); } catch { /* startup */ }
  }
  assert.ok(tabs, "isolated Chrome did not start");
  socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
  const pending = new Map(); let next = 0;
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const call = pending.get(message.id); clearTimeout(call.timer); pending.delete(message.id);
      message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === "Fetch.requestPaused") {
      const request = message.params;
      if (request.request.url.startsWith(origin + "/")) await cdp("Fetch.continueRequest", { requestId: request.requestId }).catch(() => {});
      else { blocked.push(request.request.url); await cdp("Fetch.failRequest", { requestId: request.requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
    }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  run = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("DOM.enable");
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: origin + "/rsm.html" });
  await poll("!!window.RsmApp && !document.getElementById('rsm-gate').hidden", "gate not shown");

  await check("local gate rejects wrong code and opens only after correct code", async () => {
    assert.equal(await run("document.getElementById('rsm-app').hidden"), true);
    assert.equal(gateCalls, 0);
    await input("gate-code", "wrong"); await run("document.getElementById('gate-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
    await poll("/올바르지/.test(document.getElementById('gate-status').textContent)", "wrong code was not rejected");
    await input("gate-code", code); await run("document.getElementById('gate-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
    await ready();
    assert.equal(gateCalls, 2);
    assert.equal(await run("document.getElementById('gate-code').value"), "");
    assert.equal(await run("sessionStorage.getItem('rsm-studio-open')"), "1");
  });
  await check("actual default worker output draws, labels table truncation, and exports PNG", async () => {
    assert.match(await run("document.getElementById('reflection-count').textContent"), /현재 단면 우선 600개.*전체.*CSV/);
    assert.equal(await run("document.getElementById('reflections').children.length"), 600);
    assert.match(await run("document.getElementById('profile-info').textContent"), /50 nm/);
    await screenshot("RSM_DESKTOP.png", true);
    await click("export-png");
    const png = await readDownload("rsm-map.png");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    await writeFile(path.join(output, "RSM_MAP.png"), png);
  });
  await check("shorter wavelength shows enumeration warning and manual qmax expansion clears it", async () => {
    assert.doesNotMatch(await run("document.getElementById('warnings').textContent"), /enumeration stops at/);
    await click("mask"); await ready();
    assert.match(await run("document.getElementById('warnings').textContent"), /enumeration stops at 1\.3/);
    await click("mask"); await ready();
    assert.doesNotMatch(await run("document.getElementById('warnings').textContent"), /enumeration stops at/);
    await input("lambda", 1); await ready();
    assert.equal(await run("Number(document.getElementById('qmax').value)"), 1.3);
    assert.match(await run("document.getElementById('warnings').textContent"), /enumeration stops at 1\.3/);
    await screenshot("RSM_QMAX_WARNING.png", true);
    await input("qmax", 2); await ready();
    assert.doesNotMatch(await run("document.getElementById('warnings').textContent"), /enumeration stops at/);
    await input("qmax", 1.3); await input("lambda", 1.540593);
    await demo();
  });
  await check("invalid energy cancels pending debounce and clears export/profile state", async () => {
    await run("(() => { const l=document.getElementById('lambda');l.value='1.5';l.dispatchEvent(new Event('input',{bubbles:true}));const e=document.getElementById('energy-input');e.value='';e.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await delay(600);
    assert.equal(await run("document.getElementById('export-png').disabled"), true);
    assert.match(await run("document.getElementById('profile-info').textContent"), /결과가 없습니다/);
    await input("energy-input", 8); await ready();
  });
  await check("invalid log range blocks exports and correction recovers without unrelated edits", async () => {
    await input("decades", "");
    assert.equal(await run("document.getElementById('export-png').disabled"), true);
    await input("decades", 5); await ready();
  });
  await check("invalid CIF replacement cannot export an earlier map and valid re-upload recovers", async () => {
    const bad = path.join(temp, "bad.cif"), good = path.join(temp, "film.cif");
    await writeFile(bad, "data_invalid\n_cell_length_a 4\n");
    await writeFile(good, examples.film);
    await upload("#film-file", bad);
    await poll("document.getElementById('film-status').classList.contains('error')", "invalid CIF not reported");
    assert.equal(await run("document.getElementById('export-png').disabled"), true);
    assert.match(await run("document.getElementById('profile-info').textContent"), /결과가 없습니다/);
    await upload("#film-file", good); await ready();
    assert.match(await run("document.getElementById('film-status').textContent"), /film.cif/);
  });
  await check("multiple CIF blocks require explicit selection and update the film cell", async () => {
    const file = path.join(temp, "blocks.cif");
    await writeFile(file, examples.film + examples.film.replace("data_hypothetical_film", "data_second").replaceAll("3.95", "4.1"));
    await upload("#film-file", file);
    await poll("!document.getElementById('film-block').hidden", "block selector not displayed");
    assert.equal(await run("document.getElementById('export-png').disabled"), true);
    await input("film-block", "second", "change"); await ready();
    assert.equal(await run("Number(document.getElementById('film-a').value)"), 4.1);
  });
  await check("newer lattice edits win over an obsolete worker calculation", async () => {
    await demo(); workerDelayMs = 450;
    await input("film-c", 4.1); await delay(250); await input("film-c", 4.2);
    await ready(); workerDelayMs = 0;
    const row = await run("Array.from(document.querySelectorAll('#reflections tr')).find(r=>r.children[0].textContent==='박막'&&r.children[1].textContent==='0 0 2')?.children[4].textContent");
    assert.ok(Math.abs(Number(row) - 2 / 4.2) < 1e-5, row);
  });
  let saved, savedPath;
  await check("saved settings contain original CIFs and restore edited cells without the lab code", async () => {
    await click("save-session");
    const buffer = await readDownload("rsm-settings.json");
    saved = JSON.parse(buffer);
    assert.equal(saved.format, "rsm-studio");
    assert.equal(saved.cifs.film.text, examples.film);
    assert.equal(saved.inputs["film-c"], "4.2");
    assert.equal(buffer.toString().includes(code), false);
    savedPath = path.join(temp, "settings.json"); await writeFile(savedPath, buffer);
    await input("film-c", 4.0); await ready(); await upload("#load-session", savedPath); await ready();
    assert.equal(await run("Number(document.getElementById('film-c').value)"), 4.2);
  });
  await check("a slow settings read cannot overwrite subsequent physical edits", async () => {
    assert.ok(saved);
    const file = path.join(temp, "delayed-settings.json");
    await writeFile(file, JSON.stringify({ ...saved, inputs: { ...saved.inputs, "film-c": "4.3" } }));
    await delayedSettings(file);
    await input("film-c", 4.15); await ready();
    await run("window.__rsmReleaseSettings()"); await delay(350);
    assert.equal(await run("Number(document.getElementById('film-c').value)"), 4.15);
    assert.equal(await run("document.getElementById('export-png').disabled"), false);
  });
  await check("a slow settings read cannot overwrite a newer demo choice", async () => {
    const file = path.join(temp, "delayed-settings.json");
    await run("document.getElementById('load-session').value='';delete window.__rsmReleaseSettings");
    await delayedSettings(file); await demo(); await run("window.__rsmReleaseSettings()"); await delay(350);
    assert.equal(await run("Number(document.getElementById('film-c').value)"), 4.02);
  });
  await check("changing map plane updates the slice label and geometry-mask availability", async () => {
    await input("plane", "xy", "change"); await ready();
    assert.equal(await run("document.getElementById('mask').disabled"), true);
    assert.match(await run("document.getElementById('slice-label').textContent"), /qz/);
    await input("plane", "xz", "change"); await ready();
    assert.equal(await run("document.getElementById('mask').disabled"), false);
  });
  await check("CSV exports all computed reflections and grid TXT records its conventions", async () => {
    await click("export-csv");
    const csv = (await readDownload("rsm-reflections.csv")).toString();
    assert.ok(csv.trim().split("\n").length > 601);
    assert.match(csv.split("\n")[0], /qx_A-1.*qz_A-1/);
    await click("export-grid");
    const grid = (await readDownload("rsm-grid.txt")).toString();
    assert.match(grid.split("\n")[0], /q=1\/d.*plane=xz/);
    assert.equal(grid.trim().split("\n").length, 600 * 450 + 2);
  });
  await check("mobile layout fits the viewport and retains a usable map", async () => {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(100);
    assert.equal(await run("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    await screenshot("RSM_MOBILE_FULL.png", true);
    await run("document.getElementById('figure').scrollIntoView({block:'center'})"); await delay(100);
    await screenshot("RSM_MOBILE_MAP.png");
    assert.equal(await run("document.getElementById('export-png').disabled"), false);
  });
  await check("simulation makes no external requests and emits no page exceptions", async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(blocked, []);
    assert.equal(gateCalls, 2);
    assert.ok(requests.every(request => request.method === "GET" || request.path === "/test-relay"));
  });
} catch (error) {
  records.push({ name: "harness setup", pass: false, error: error.stack });
  console.error(error.stack);
} finally {
  await writeFile(path.join(output, "results.json"), JSON.stringify({
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    finishedAt: new Date().toISOString(), records, pageErrors, blocked, gateCalls, requests
  }, null, 2));
  if (socket) socket.close();
  if (chrome && !chrome.killed) { chrome.kill(); await delay(250); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
console.log(records.filter(record => record.pass).length + "/" + records.length + " RSM page checks passed. Evidence: " + output);
if (records.some(record => !record.pass)) process.exitCode = 1;
